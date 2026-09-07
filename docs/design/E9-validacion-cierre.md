# E9 — Validación contable del cierre, los recurrentes y la fiscalidad periódica

> Rol: `experto-contable`. Valida `docs/design/E9-cierre-recurrentes.md` (Ronda 0) y `docs/adr/0016-cierre-recurrentes-y-fiscalidad-periodica.md` (**PROPUESTO**, D1–D8). Responde **Q-1 … Q-14** de §11 (diez bloqueantes).
> Fuentes internas: `docs/design/E3-asientos-tipo.md` (T-01…T-28, C-1…C-13, R-IVA-1…8, §6.1–6.6), `docs/design/E8-validacion-documentos.md`, `docs/design/E5-validacion-liquidacion.md`, ADR-0003 / 0005 / 0006 / 0009 / 0012 / 0013 / 0014 / 0015, skills `pgc-npgc`, `estados-financieros`, `fiabilidad`, `seeds/npgc.csv`.
> Norma aplicada: **RD 1514/2007** (PGC 2007, consolidado RD 1159/2010, RD 602/2016, RD 1/2021) — **marco conceptual**, **NRV 2ª, 3ª, 9ª, 10ª, 11ª, 13ª, 14ª, 22ª**, 3ª parte (definiciones y relaciones contables), norma **6ª** de elaboración de las cuentas anuales · **RD 1515/2007** (PGC PYMES) · **Código de Comercio** arts. 25, 27, 28, 29, 30, 34, 35, 38 · **RDL 1/2010 (LSC)** arts. 164, 253, 272, 273, 274, 279 · **Ley 37/1992 (LIVA)** arts. 4, 8, 13, 20, 75, 83, 84, 92–99, 101, 103–110, 163 *decies* a 163 *sexiesdecies*, 167 · **RD 1624/1992 (RIVA)** arts. 30, 61 *decies*, 61 *undecies*, 63, 64, 74 · **Ley 27/2014 (LIS)** arts. 10, 11, 12, 13, 29, 40, 102 y **RD 634/2015 (RIS)** art. 4 · **Ley 35/2006 (LIRPF)** art. 101 y **RD 439/2007 (RIRPF)** arts. 75–76, 100 · **Ley 15/2010** y art. 262 LSC.
> **Todas las cifras son ilustrativas, en céntimos enteros, y van marcadas `(ejemplo)`.** Ninguna procede de datos reales.

---

## 0. Veredicto

> **Ronda 0 (abajo): NO CONFORME**, con 22 observaciones bloqueantes y 8 no bloqueantes.
> **Ronda 1 del arquitecto → Ronda 2 de validación (§§7-10, al final del documento): las treinta cerradas. Veredicto final CONFORME CON OBSERVACIONES**, con tres correcciones de texto (R2-1, R2-2, R2-3) y **sin tercera ronda**.

| Decisión | Veredicto |
|---|---|
| **D1** Cierre y reapertura | **CONFORME CON OBSERVACIONES** (O-20, O-21) |
| **D2** Amortización lineal, mes entero, residuo a la última cuota | **CONFORME CON OBSERVACIONES** (O-19, O-22, O-23, O-30) |
| **D3** Periodificación 480/485/567/568 | **CONFORME CON OBSERVACIONES** (O-25) |
| **D4** Prorrata definitiva y regularización | **NO CONFORME** (O-9, O-10, O-11, O-12, O-13) |
| **D5** Reclasificación corriente / no corriente | **NO CONFORME** (O-6, O-7, O-8) |
| **D6** Diferencias de cambio al cierre | **NO CONFORME** (O-4, O-5) |
| **D7** Valor actual del aplazamiento | **NO CONFORME** (O-1, O-2, O-3) |
| **D8** RECC y REDEME | **NO CONFORME** (O-14, O-15, O-16) |
| **Alcance de E9** (ciclo de cierre completo) | **NO CONFORME**: falta la **distribución del resultado** (O-18) y el orden de asientos está mal en un tramo (O-17) |

**Veredicto global: NO CONFORME.** Diez defectos son bloqueantes porque producen **un balance mal clasificado, una PyG con el resultado en el ejercicio equivocado o una autoliquidación incorrecta** — no imprecisa: incorrecta. Ninguno está en la arquitectura, que es sólida; todos están en el mapeo contable y fiscal.

**Lo que está bien y no debe reabrirse.** El cierre como acto sellado con lista bloqueante evaluada **también en servidor**; el cuadro de amortización como función pura no almacenada (ADR-0003); la idempotencia por índice único y no por `if`; `Δ = D×r − S` sin restar lo ya reconocido (lección N-1 de E7, y es **contablemente** correcta, no sólo operativamente); el rechazo explícito de los métodos degresivos en vez de un enum inerte; la prorrata como porcentaje **entero redondeado al alza** con CHECK de múltiplo de 100 (art. 104.Dos.2ª LIVA); el régimen de IVA **fechado** en vez de columna — sin `VatRegimePeriod` se reagruparían periodos ya presentados, y eso solo se descubre en una inspección; la reversión periodo a periodo de la periodificación; la negativa a adivinar un vencimiento ausente; y `pct`/`bps` en aritmética entera. Aplicadas O-1…O-22, el diseño pasa a **CONFORME CON OBSERVACIONES**.

---

## 1. Respuestas a las catorce cuestiones

| # | Respuesta en una línea | Veredicto | Observaciones |
|---|---|---|---|
| **Q-1** | Sí: reabrir antes de la formulación es corregir un cierre propio, no reformular. La frontera societaria es la correcta | **SÍ, con condiciones** | O-20, O-21 |
| **Q-2** | Residuo a la **última** cuota. Nunca a la primera, nunca por Hamilton | **CONFIRMADO** | O-22 |
| **Q-3** | Lineal basta en v1: lo demás es fiscal y extracontable | **SÍ** | O-23 |
| **Q-4** | **Mes entero** desde `inServiceDate`, aplicado con uniformidad | **SÍ** | O-30 |
| **Q-5** | **Se automatiza**: la baja manual es donde se rompe I-E9-5 | **CAMBIO** | O-24 |
| **Q-6** | ACT/ACT, días naturales, **extremos incluidos**. Para 567/568 **no** por defecto | **SÍ / NO** | O-25 |
| **Q-7** | Contrapartida **472**: es lo que dice la 3ª parte del PGC. Signo correcto. La **base** del ajuste está mal definida | **PARCIAL** | O-9, O-11 |
| **Q-8** | Aceptable **sólo** con guardia bloqueante; una casilla vacía con nota no basta | **CONDICIONADO** | O-12 |
| **Q-9** | 4728/4778 son convención admisible; el 31-12 sí es asiento de cierre; el destinatario **sí** difiere | **SÍ, incompleto** | O-14, O-15, O-16 |
| **Q-10** | El mapa está bien estructurado pero **roto**: la cadena 46 → 71 no cierra | **NO CONFORME** | O-13 |
| **Q-11** | FIFO aceptable como simplificación declarada, con matices del art. 1174 CC | **SÍ, con matices** | O-6 |
| **Q-11b** | **Se revierte en la apertura.** Pero como asiento nº 2, después de T-28 | **CONFIRMADO** | O-8 |
| **Q-12** | Basta orquestar T-25 con base humana, si el checklist pregunta por lo diferido | **SÍ, condicionado** | O-26 |
| **Q-13** | El descuento **no es un ajuste de cierre**: es valoración inicial. Y `i/12` sólo vale si el tipo es nominal | **NO CONFORME** | O-1, O-2, O-3 |
| **Q-14** | Orden **incorrecto** en un tramo: reclasificación después de FX y valor actual | **CORRECCIÓN** | O-17 |

### Q-1 · Reapertura del ejercicio

**Es admisible, y la frontera propuesta es la correcta.** Un ejercicio `CLOSED` con las cuentas en `BORRADOR` no es una cuenta anual rendida: es un estado interno del ERP. Reabrirlo por contra-asiento (T-21 de T-28 → T-27 → T-26, en ese orden inverso) no toca ninguna cuenta formulada y respeta el art. 29.1 CCom (sin tachaduras ni raspaduras: **nada se borra**) y el art. 30 CCom (conservación). El «nunca» de E3 §9.2-4 se escribió para el caso en que las cuentas ya están **formuladas** por los administradores (art. 253 LSC) y, típicamente, aprobadas por la junta (art. 272 LSC) y depositadas (art. 279 LSC), y para ese caso **sigue siendo correcto**: la vía es T-22 contra 113/121 (error material o cambio de criterio, NRV 22ª) o 678/778 si no es significativo.

La enmienda del ADR está bien planteada. Tres precisiones que hay que escribir:

1. **La formulación no es en Derecho una barrera absoluta** —entre la formulación y la aprobación cabe la reformulación acordada por el órgano de administración (NRV 23ª, hechos posteriores al cierre)—, pero **sí debe serlo en el ERP**: la reformulación es un acto societario con acta, no una operación de usuario. Mantener el rechazo en `FORMULADAS` es lo correcto; lo que falta es que el mensaje de rechazo **no diga «imposible» sino «requiere acuerdo de reformulación; regístrelo y vuelva a marcar el ejercicio como BORRADOR»**, porque si el producto no ofrece salida, el usuario la fabricará por SQL.
2. **Falta el estado fiscal.** Si el modelo 200 del ejercicio ya se presentó, reabrir cambia cifras declaradas y obliga a autoliquidación complementaria o rectificativa (art. 122 LGT). El checklist de reapertura debe advertirlo y `AuditLog` recogerlo. Un `FiscalYear.taxFilingStatus` es la forma limpia; como mínimo, un aviso obligatorio.
3. **I-E9-21 se queda corta**: comprueba «cada cuenta de balance». Tras revertir T-26, también deben volver a su saldo previo **todas** las cuentas de los grupos 6 y 7, y **129 debe quedar en cero**. Si no se comprueba, una reapertura que revierte mal T-26 pasa el invariante y deja la PyG partida.

Ver **O-20** (numeración) y **O-21** (asientos de cierre no revertidos).

### Q-2 · Residuo de la amortización

**A la última cuota. Confirmado, y es la única opción defendible.** `q = trunc(base / n)`, residuo `base − n·q ∈ [0, n−1]` a la cuota `n`. Razón contable: la amortización es la distribución sistemática del importe amortizable **a lo largo de la vida útil** (NRV 2ª.2.1); si el residuo se lleva a la primera cuota o se reparte por Hamilton, el activo alcanza su valor residual **antes** de agotar su vida útil, lo que equivale a una amortización acelerada no justificada y, en el último mes, a un activo en uso con cuota cero. La alternativa «cuota redondeada al alza y última menor» es igualmente aritmética pero deja la última cuota **inferior** a las demás sin causa; con `trunc` la última es la que cuadra y la diferencia máxima es de `n−1` céntimos.

*(ejemplo)* coste `1 000 000`, residual `100 000`, vida 7 meses ⇒ base `900 000`; `q = trunc(900000/7) = 128 571`; `128 571 × 7 = 899 997`; residuo `3` ⇒ cuota 7 = `128 574`. Σ = `900 000` exactos (criterio 4 de §12, correcto).

Asiento mensual (T-14), *(ejemplo)* mes 1: `681 (D) 128 571 / 2811 (H) 128 571`.

Ver **O-22**: el caso `base < n` produce cuotas de cero céntimos y hay que resolverlo.

### Q-3 · ¿Basta el método lineal?

**Sí, y la razón importa: la amortización del diario es la CONTABLE, no la fiscal.** El PGC no impone método; exige uno **sistemático y racional** en función de la vida útil, la depreciación y el valor residual (NRV 2ª.2.1). Para PYMEs de proyectos y servicios (equipos informáticos, mobiliario, instalaciones, software) el lineal es el método universalmente empleado y el único que la práctica documenta.

Lo que **no** debe hacerse es confundirlo con la amortización fiscal:

| Concepto fiscal | Norma | Dónde vive |
|---|---|---|
| Tablas de coeficientes (coeficiente máximo / periodo máximo) | art. 12.1.a) LIS | **Sugerencia** en la UI al dar de alta el activo, tabla estática, nunca LLM |
| Porcentaje constante y números dígitos | art. 12.1.b) y c) LIS | Fuera de v1; si se usan, **ajuste extracontable** |
| Libertad de amortización (ERD con creación de empleo, elementos de escaso valor, I+D, energías renovables) | arts. 12.3, 102 LIS | **Extracontable**: jamás se contabiliza. Genera diferencia temporaria **imponible** ⇒ `479` contra `6301` |
| Elementos de valor unitario < 300 € hasta 25 000 €/año | art. 12.3.e) LIS | Ídem |

Si el motor permitiera «amortizar libremente» en el diario, la PyG quedaría mal y el resultado contable dejaría de ser el punto de partida del art. 10.3 LIS. Ver **O-23**.

### Q-4 · Convención temporal

**Mes entero desde `inServiceDate`.** Es una simplificación admisible siempre que se aplique con **uniformidad** (art. 38.d CCom, principio de uniformidad) y su efecto no sea material. Lo relevante es que el inicio se ancle en la **puesta en condiciones de funcionamiento** (NRV 2ª.1 y 3ª), no en la fecha de factura: un equipo comprado en marzo e instalado en junio se amortiza desde junio, y el diseño lo hace bien. Fiscalmente el art. 4 RIS prorratea el primer año, pero la diferencia máxima —29/365 de una cuota anual— es un ajuste extracontable irrelevante en este segmento y, en todo caso, no altera el total amortizado.

Condición: la convención debe quedar **escrita en la memoria** (norma de valoración de inmovilizado) y ser la misma para el alta y para la baja. Ver **O-30**.

### Q-5 · Baja y venta de inmovilizado

**Se automatiza. Dejarlo como T-20 manual es un error, y es el error que rompe I-E9-5.** La baja manual es exactamente donde el usuario olvida cancelar `281x`, se equivoca de signo en `671`/`771` o da de baja el activo en el fichero sin asiento. Dos plantillas nuevas:

**Baja sin contraprestación (desguace, siniestro sin indemnización)** *(ejemplo)*: coste `1 000 000`, amortización acumulada al mes de baja `640 000`.

| Cuenta | Debe | Haber | Regla |
|---|---|---|---|
| `2811` Amortización acumulada | 640 000 | | Saldo del cuadro **hasta el mes de baja inclusive** (dotarlo antes) |
| `671` Pérdidas procedentes del inmovilizado material | 360 000 | | VNC = coste − acumulada − deterioro |
| `2131` Maquinaria | | 1 000 000 | Coste íntegro; el activo queda en `BAJA` |

**Venta** *(ejemplo)*: precio `500 000` + IVA 21 % `105 000`; mismo activo.

| Cuenta | Debe | Haber |
|---|---|---|
| `543` Créditos a c/p por enajenación de inmovilizado | 605 000 | |
| `2811` | 640 000 | |
| `2131` | | 1 000 000 |
| `477` IVA repercutido | | 105 000 |
| `771` Beneficios procedentes del inmovilizado material | | 140 000 |

Dos correcciones que el diseño no contempla y un auditor sí mira:

- **La contrapartida de la venta de inmovilizado es `543` (o `253` si el aplazamiento supera el año), nunca `430`.** `430` recoge créditos por la actividad ordinaria; meter ahí la venta de una furgoneta contamina el *aging*, el DSO y el PMC. El par `253 ↔ 543` ya está sembrado en `ReclassificationPair`, así que la pieza existe: sólo hay que usarla.
- **Aviso fiscal obligatorio**: si el elemento es **bien de inversión** (> 3 005,06 €, art. 108 LIVA) y se vende dentro del periodo de regularización, procede la regularización **única** del art. 110 LIVA; si es edificación, hay que decidir sobre la exención del art. 20.Uno.22º y la eventual renuncia con ISP (art. 84.Uno.2º.e). Nada de esto se automatiza en v1, pero la pantalla debe decirlo.

Ver **O-24**.

### Q-6 · Periodificación por días

**ACT/ACT, días naturales, ambos extremos incluidos. Confirmado para 480/485.** No existe norma contable que imponga 30/360 —es un convenio financiero, no contable— y el devengo (marco conceptual, principio de devengo; NRV 14ª) se mide por el tiempo real de prestación. Un seguro del 15/11/2026 al 14/11/2027 cubre **365 días**, y el intervalo cerrado es la única lectura que hace coincidir el recuento con el periodo contratado.

*(ejemplo)* prima `100 000`, 365 días, 47 días en 2026 (15/11–31/12) y 318 en 2027:
`2026 = trunc(100 000 × 47 / 365) = 12 876` · `2027 = 87 124` (residuo `1` a la última fila). Σ = `100 000`, saldo de `480` en cero exacto.

**Para 567/568 la respuesta es NO por defecto.** Los intereses son la remuneración de un pasivo o un activo financiero y se devengan por el **tipo de interés efectivo** sobre el coste amortizado (NRV 9ª.2.2 y 9ª.3.1): sobre un principal que se amortiza, el reparto lineal por días carga los primeros periodos de menos y los últimos de más. Regla correcta:

- Principal **constante** durante todo el intervalo y horizonte ≤ 12 meses ⇒ el lineal por días es una aproximación admisible por inmaterialidad, y basta.
- Principal **decreciente** (préstamo con cuadro) ⇒ el devengo lo aporta el **cuadro de amortización del préstamo**, no un `Accrual` lineal. Mientras ese módulo no exista, `basis = DIAS` sobre 567/568 debe emitir un **WARN** con motivo y el importe de la desviación estimada.

El resto de D3 es correcto: 438 y 407 no son periodificaciones (son anticipos con IVA devengado); 567/568 son `FINANCIERO` a nivel BAI contra 662/762 —tratarlos como 480/485 movería el EBITDA, y el diseño lo ve—; la reversión periodo a periodo es la única compatible con un devengo que cruza el cierre; y la cancelación anticipada devenga el pendiente en el periodo de la cancelación en vez de borrarlo. Ver **O-25**.

### Q-7 · Regularización de la prorrata

**La contrapartida `472` es correcta y no es una elección: es lo que dicta la 3ª parte del PGC.** La definición de la cuenta 634 dice literalmente que *se cargará por el importe de los ajustes, con abono a la cuenta 472*, y la de 639 que *se abonará … con cargo a la cuenta 472*. El signo del diseño también es correcto:

| Situación | `ajuste = deducible_definitivo − deducido_provisional` | Asiento | Casilla 44 |
|---|---|---|---|
| Definitiva **mayor** que provisional (se dedujo de menos) | `> 0` | `472 (D) / 639 (H)` | **positiva** |
| Definitiva **menor** que provisional (se dedujo de más) | `< 0` | `634 (D) / 472 (H)` | **negativa** |

Pero **la base sobre la que se calcula está mal escrita** (R-IVA-12 y D4.3 dicen «sobre la cuota soportada deducible del año»). El ajuste se calcula sobre la **cuota soportada prorrateable del año** —la que entra en el mecanismo de prorrata—, aplicando la diferencia de porcentajes; **no** sobre lo ya deducido. Ver **O-9**, con el ejemplo numérico. Y falta la regla de derivación del numerador y el denominador (**O-10**) y el momento y periodo de posteo del asiento (**O-11**).

Dos límites que hay que declarar: el ERP implementa **prorrata general**; la **prorrata especial** (art. 103.Dos LIVA) y los **sectores diferenciados** (art. 101 LIVA) quedan fuera y deben bloquearse, no aproximarse.

### Q-8 · Bienes de inversión (art. 107, casilla 43)

**Aceptable dejarlo fuera de v1 sólo si el producto se niega a cerrar en silencio.** La regularización del art. 107 LIVA procede cuando, en alguno de los **cuatro** años siguientes al de adquisición —**nueve** para terrenos y edificaciones—, la prorrata definitiva difiere en **más de diez puntos porcentuales** de la del año de adquisición, sobre bienes de inversión del art. 108 (> 3 005,06 €, vida > 1 año). Es una cifra **declarable**, y su omisión no es un vacío neutro: hace que el 303 del último periodo y el 390 sean incorrectos.

Una casilla en blanco con una nota es honesta frente al usuario, pero no frente a la AEAT. Lo que se exige (**O-12**): si la organización ha tenido en algún año del periodo de regularización una `prorrataBps ≠ 10000` **y** existe algún alta de grupo 2 en ese arco, el paso `PRORRATA_DEFINITIVA` del checklist sale **FAIL bloqueante**, con motivo de sello `REGULARIZACION_BIENES_INVERSION_PENDIENTE`, y la liquidación del último periodo no se postea. En cualquier otro caso, la casilla 43 puede quedar vacía con su aviso.

### Q-9 · RECC

Tres respuestas y tres defectos.

- **¿4728/4778 o subcuentas de 472/477?** Ambas son convención de software; ninguna es oficial (como 4750/4700, que el seed tampoco crea). La práctica de los despachos usa mayoritariamente subcuentas del propio 472/477 —típicamente `4720`/`4770` como «pendiente»— precisamente para que el saldo siga presentándose en el epígrafe de *Otros créditos / Otras deudas con las Administraciones Públicas* sin remapear el balance. **Acepto 4728/4778** siempre que se creen como hijas de 472 y 477 (prefijo, `parentCode` derivado) y hereden `statement` y `epigraph` del padre. La condición del ADR —*sin las cuentas mapeadas no se puede activar el régimen*— es correcta y debe mantenerse.
- **¿El 31-12 del año siguiente es un asiento de cierre automático?** Sí. El art. 163 *terdecies* LIVA fija el devengo del repercutido en el cobro y, en todo caso, el **31 de diciembre del año inmediato posterior** al de la operación; la deducción del soportado sigue la misma regla respecto del pago. Es una regla determinista sobre las facturas pendientes: `4778 → 477` y `4728 → 472`, con fecha 31/12 de ese año, **antes** de la última liquidación de ese periodo. No es opcional ni es un aviso.
- **¿El destinatario en régimen general de un proveedor RECC difiere su deducción?** **Sí, sin excepción.** Es la dirección que se olvida y la que la Inspección comprueba, y `Counterparty.ivaRegime` es la forma correcta de resolverlo. Las obligaciones registrales adicionales —fechas e importes de cobro/pago y medio empleado, tanto del acogido (art. 61 *decies* RIVA) como del destinatario no acogido (art. 61 *undecies* RIVA)— hay que reflejarlas en el libro registro, o el libro no cumple.

Defectos: **O-14** (los puentes al 303 se rompen), **O-15** (falta la regla del cobro parcial), **O-16** (REDEME y el diferimiento del IVA a la importación).

### Q-10 · Mapa de casillas del 303

La estructura por bloques es correcta y la decisión de llevarla a **tabla versionada con vigencia** en vez de a un `switch` es la única sostenible: el modelo cambia por orden ministerial y una cifra declarable atada a un `if` es lo que ADR-0012 prohíbe. Pero el mapa entregado **no permite rellenar el modelo**: se salta de la casilla 46 a la 71 y omite el tramo que las une. Corrección completa en **O-13**.

### Q-11 y Q-11b · Vencimientos

**FIFO es aceptable como simplificación declarada.** No existe norma contable que diga qué vencimiento cancela un pago; el Código Civil (arts. 1172–1174) da la regla civil —elige el deudor; en su defecto, la deuda **más onerosa**; en igualdad, a prorrata—, que sólo coincide con FIFO cuando todos los vencimientos son igualmente onerosos. En una cartera comercial sin intereses eso se cumple, y FIFO es lo que hace la práctica. Condiciones para que sea defensible:

1. Se aplica **por `(cuenta, contraparte, divisa)`** y jamás entre contrapartes.
2. El orden es por **`dueDate` ascendente**, con desempate por `entryNumber` (determinismo P7).
3. **No se compensan** saldos deudores y acreedores de la misma contraparte en cuentas distintas (art. 35.6 CCom). Un proveedor con anticipo (`407`) y deuda (`400`) presenta las dos partidas.
4. Cuando la contraparte tiene vencimientos con **onerosidad distinta** —uno con interés implícito reconocido por T-31 y otro sin él— FIFO deja de ser neutral: WARN listando el caso, hasta que exista `SettlementAllocation` (E10).

**Q-11b: la reversión en la apertura es la decisión correcta.** La reclasificación es un ajuste de **presentación** exigido por la norma 6ª de elaboración de las cuentas anuales, no un hecho económico: si se dejara «pegada», los pagos del ejercicio siguiente cancelarían `173` en vez de `523`, la base del FIFO quedaría contaminada y el segundo año reclasificaría sobre lo ya reclasificado. Pero el **orden** dentro de la apertura está mal (**O-8**): T-27 y T-28 deben llevar ya los saldos reclasificados —el balance a 31/12 es el reclasificado— y el contra-asiento de T-32 es el asiento **nº 2** del ejercicio nuevo, nunca antes de T-28.

*(ejemplo)* proveedor de inmovilizado, cierre 31/12/2026, saldo vivo tras FIFO: `250 000` con vencimiento 30/09/2027 y `500 000` con vencimiento 30/06/2028.

| Fecha | Asiento | Cuenta | Debe | Haber |
|---|---|---|---|---|
| 31/12/2026 | T-32 | `523` Proveedores de inmovilizado a c/p | 500 000 | |
| | | `173` Proveedores de inmovilizado a l/p | | 500 000 |
| 01/01/2027 | nº 2, contra-asiento de T-32 | `173` | 500 000 | |
| | | `523` | | 500 000 |

`Σ 523 + Σ 173 = 750 000` antes y después (I-E9-16 ✓).

### Q-12 · Impuesto sobre beneficios

**Sí: orquestar T-25 con una base imponible introducida y justificada por una persona es aceptable en v1**, siempre que el producto no simule completitud. El resultado contable antes de impuestos es el punto de partida (art. 10.3 LIS) y los ajustes extracontables, las BIN (art. 26 LIS) y las deducciones son un módulo propio.

Asiento correcto *(ejemplo)*: base imponible `2 000 000`, tipo 25 % (art. 29.1 LIS), retenciones soportadas del ejercicio `120 000`, pagos fraccionados del modelo 202 `180 000`.

| Cuenta | Debe | Haber | Regla |
|---|---|---|---|
| `6300` Impuesto corriente | 500 000 | | Cuota líquida = base × tipo − bonificaciones − deducciones |
| `473` H.P., retenciones y pagos a cuenta | | 300 000 | **Cancela** retenciones soportadas + pagos fraccionados |
| `4752` H.P. acreedora por impuesto sobre sociedades | | 200 000 | Cuota **diferencial**. Si fuese negativa, `4709` al debe |

Durante el ejercicio, cada pago fraccionado: `473 (D) 60 000 / 572 (H) 60 000` *(ejemplo)*.

Tres exigencias (**O-26**): la cuenta es **6300**, no el padre `630`; T-25 **debe** cancelar el saldo de `473` —en el fixture de E3 la cuenta 473 queda viva con `120 000` y el `4752` recoge la cuota íntegra, lo que sobrevalora simultáneamente un activo y un pasivo—; y el checklist debe **preguntar explícitamente** por diferencias temporarias, BIN y deducciones pendientes, dejando el sello en `REQUIERE_REVISION` con motivo `IMPUESTO_DIFERIDO_NO_RECONOCIDO` si la respuesta es afirmativa, porque la NRV 13ª obliga a reconocer `4740` / `4745` / `479` contra `6301` y no reconocerlos es una omisión, no un aplazamiento.

### Q-13 · Valor actual del aplazamiento

**El planteamiento de fondo es incorrecto, y es el defecto más caro de la épica.** El descuento del aplazamiento **no es un ajuste de cierre**: es **valoración inicial**. La NRV 2ª.1 dice que el precio de adquisición del inmovilizado incluye el importe facturado *«y … si el aplazamiento supera el año, se valorará por el valor actual»*, y la NRV 9ª.3.1 lo replica para el débito. El valor actual **es** el precio de adquisición desde el primer día; reconocerlo meses después contra la cuenta de resultados convierte un criterio de valoración en un ajuste de periodo. Detalle en **O-1**, con las tres vías (mismo ejercicio, ejercicio cerrado, origen no inmovilizado).

Sobre las otras tres preguntas:

- **Umbral de materialidad.** El umbral existe —la NRV 9ª y el PGC de PYMES permiten no actualizar cuando el efecto no es material— pero **no es un número libre**: debe derivarse de la materialidad de las cuentas en su conjunto (marco conceptual, característica de *relevancia*) y quedar documentado. Recomendación: `pvMaterialityCents` por defecto = el menor entre el **0,5 % del total del activo** del ejercicio anterior y un tope fijo declarado, versionado en `AuditLog`, y **nunca** editable sin motivo. Un umbral arbitrario es una puerta para no descontar nada.
- **Nominal con capitalización mensual o efectivo anual.** Las dos son admisibles, pero hay que **decir cuál se declara**, porque no dan el mismo céntimo. Ver **O-2**: sobre `10 000 000` a 24 meses al 6 %, la diferencia es de `28 051` céntimos.
- **Si el activo ya se está amortizando.** No se puede resolver con `AssetRevision`: una revisión es un **cambio de estimación** y es prospectiva (NRV 22ª), mientras que reconocer tarde un criterio de valoración obligatorio es la **corrección de un error**, que es retroactiva. Ver **O-1**.

### Q-14 · Orden de los asientos de cierre

El orden propuesto —recurrentes → reclasificación → diferencias de cambio → valor actual → impuesto → T-26 → T-27 → T-28— es correcto **en las tres últimas posiciones** y equivocado en el tramo de ajustes. Orden correcto en **O-17**. Y sí: el impuesto va **después** de las diferencias de cambio y **antes** de la regularización, porque 668/768 son gasto e ingreso del ejercicio y forman parte del resultado contable del que arranca la base imponible (art. 10.3 LIS); y T-26 tiene que barrer también la `6300`.

---

## 2. Observaciones numeradas

### Bloqueantes

---

#### O-1 · El valor actual del aplazamiento es valoración inicial, no ajuste de cierre — **D7, R-VA-4, Q-13**

**Norma:** NRV 2ª.1 y 3ª (precio de adquisición del inmovilizado), NRV 9ª.3.1 (débitos y créditos), NRV 22ª (errores frente a cambios de estimación).

**Defecto.** T-31 reconoce al cierre un descuento que la norma exige en el reconocimiento inicial, y lo lleva *«contra el coste del activo o el gasto, según el origen»* sin decir qué pasa cuando el activo ya se está amortizando. Si se reduce `2131` en diciembre y el activo lleva diez meses amortizándose sobre el coste bruto, `281x` recoge más amortización de la que corresponde al nuevo importe amortizable: **I-E9-5 pasa a FAIL** (28x > base) y, si la vida es corta, la amortización acumulada puede superar el coste rebajado.

**Corrección.** El descuento se reconoce en el **alta** (T-03 de E8, con el aplazamiento ya conocido). Cuando no se hizo, se corrige así:

| Caso | Tratamiento | Asiento |
|---|---|---|
| **A.** Alta del **ejercicio en curso**, cuentas no formuladas | Corrección dentro del propio ejercicio: reducir el coste, **recalcular el cuadro desde `inServiceDate`** (no `AssetRevision`: no es cambio de estimación) y revertir la amortización dotada en exceso | `523/173 (D) descuento / 2131 (H) descuento` **y** `2811 (D) exceso / 681 (H) exceso` |
| **B.** Alta de un **ejercicio cerrado** | **Error** de ejercicios anteriores (NRV 22ª): se corrige contra reservas en el ejercicio abierto, por T-22, y se reexpresa el comparativo | `523/173 (D) / 113 (H)` por el efecto neto acumulado, con desglose en la memoria |
| **C.** Origen **no inmovilizado** (servicio, venta aplazada) | Al gasto o ingreso original si es del mismo ejercicio; a `113` si es de un ejercicio cerrado | — |

En los tres casos, el **interés implícito** devengado desde el reconocimiento hasta el corte va a `662` (pasivo) o `762` (activo) periodo a periodo, con la misma lógica de reversión de D3, no en un único asiento.

*(ejemplo, caso A)* deuda por maquinaria, nominal `10 000 000`, 24 meses, tipo declarado 6 % efectivo anual ⇒ valor actual `8 899 964`, descuento `1 100 036`. Puesta en servicio 01/03; al 31/12 hay 10 meses amortizados sobre `10 000 000` con vida 60 meses: acumulada `1 666 660`. Tras la corrección, base `8 899 964`, cuota `trunc(8 899 964/60) = 148 332`, acumulada correcta `1 483 320`, exceso `183 340`.

| Cuenta | Debe | Haber |
|---|---|---|
| `173` Proveedores de inmovilizado a l/p | 1 100 036 | |
| `2131` Maquinaria | | 1 100 036 |
| `2813` Amortización acumulada | 183 340 | |
| `6813` Amortización del inmovilizado material | | 183 340 |
| `662` Intereses de deudas *(10 meses de interés implícito)* | 454 133 | |
| `173` | | 454 133 |

**I-E9-19** debe reformularse: `descuento inicial = Σ intereses implícitos de toda la vida del pasivo`, y a vencimiento el pasivo vale su nominal.

---

#### O-2 · El tipo de descuento es ambiguo y `i/12` no es el efectivo anual — **D7, R-VA-2**

**Defecto.** `i_m = annualRateBps / 12` es correcto **si y sólo si** `discountRateBps` es un tipo **nominal** con capitalización mensual (un TIN). Si el usuario introduce el tipo efectivo/TAE que le da su banco —que es lo que hará—, el motor descuenta de más.

*(ejemplo)* nominal `10 000 000`, 24 meses, 6 % anual:

| Interpretación | Valor actual | Diferencia |
|---|---|---|
| `i_m = 0,5 %` (nominal, capitalización mensual) | `8 871 913` | — |
| `i_a = 6 %` efectivo ⇒ `i_m = 1,06^(1/12) − 1` | `8 899 964` | **`28 051`** |

Con tolerancia 0 en I-E9-19, `28 051` céntimos no son un redondeo.

**Corrección.** Que la organización declare directamente el **tipo mensual** en punto fijo (`discountRateMonthlyMicroBps`), derivado una sola vez por una persona a partir del tipo que le da su entidad, versionado en `AuditLog` y mostrado en pantalla con su equivalente anual. Elimina la ambigüedad, elimina la raíz duodécima y deja todo el cálculo como una cadena de multiplicaciones enteras, que es lo que R-VA-2 quiere.

---

#### O-3 · Falta la cuenta del interés implícito del lado del activo — **D7, R-VA-4**

**Defecto.** R-VA-4 sólo contempla `662`. Un crédito por enajenación de inmovilizado a más de doce meses (`253`) también se descuenta, y su interés implícito es **ingreso**.

**Corrección.** `762` Ingresos de créditos, `FINANCIERO`, nivel BAI, CECO `CC-FIN`, simétrico a 662. *(ejemplo)*: `253 (D) 45 000 / 762 (H) 45 000`.

---

#### O-4 · El barrido de diferencias de cambio incluye partidas **no monetarias** — **D6, R-FX-2, I-E9-17**

**Norma:** NRV 11ª.2.2 — sólo las **partidas monetarias** se convierten al tipo de cambio de cierre; las no monetarias valoradas a coste histórico se mantienen al tipo de la fecha de la transacción y **no generan diferencia**.

**Defecto.** `readFxPositions` agrupa *«sobre `journal_lines` con `original_currency IS NOT NULL`»*. Eso arrastra `407` (anticipos a proveedores) y `438` (anticipos de clientes), que son partidas **no monetarias** —no dan derecho a recibir ni obligan a entregar un importe fijo de efectivo, sino un bien o un servicio— y también `33x`/`35x` si algún día llevan divisa. Reconocer una diferencia de cambio sobre un anticipo es un error de valoración: infla o desinfla la PyG por un importe inventado.

**Corrección.** Un atributo explícito, no una lista en el motor: `Account.isMonetary Boolean`, sembrado desde `seeds/npgc.csv` (monetarias: 17x, 40x, 41x, 43x, 44x, 46x, 52x, 53x, 54x, 55x, 57x, 18x/26x de fianzas; **no** monetarias: 20x, 21x, 3xx, `407`, `438`, `480`/`485`). `readFxPositions` filtra por `isMonetary = true` e **I-E9-17** se evalúa sólo sobre ese universo. La lista se puede editar por organización con `AuditLog`, nunca hardcodear.

---

#### O-5 · «Sin tasa a la fecha de corte no se cierra» bloquea el cierre uno de cada siete años — **D6, R-FX-4**

**Defecto.** El BCE publica tipos de referencia los días hábiles TARGET. Cuando el 31 de diciembre cae en sábado o domingo —2028, 2033…— **no hay tasa con `rateDate = corte`**, `missingRates` sale poblado, el paso `DIFERENCIAS_DE_CAMBIO` queda FAIL y el cierre **no avanza nunca**. El producto quedaría inutilizable en el único día en que se usa.

**Corrección.** «Tipo de cambio de cierre» (NRV 11ª.2.2) significa el vigente a la fecha de cierre, y el vigente un domingo es el último publicado. Regla: `r = la tasa de mayor rateDate ≤ cutoff` para el par, con la `rateDate` **efectiva sellada en el asiento y visible en pantalla**, y un FAIL sólo si no existe ninguna tasa dentro de una ventana declarada (p. ej. 7 días naturales). Es exactamente el criterio que ADR-0014 D2 ya aplica a la tasa del documento: no se inventa, se usa la publicada y se dice cuál.

*(ejemplo)* posición `400` en USD: `D = −500 000` (5 000,00 USD acreedores), `S = −460 000`; tasa de cierre efectiva 0,900000 EUR/USD ⇒ `convert(D, r) = −450 000`; `Δ = −450 000 − (−460 000) = +10 000`.

| Cuenta | Debe | Haber | `originalCurrency` | `originalAmountCents` |
|---|---|---|---|---|
| `400` Proveedores (USD) | 10 000 | | USD | **0** |
| `768` Diferencias positivas de cambio | | 10 000 | — | — |

El signo se resuelve solo (R-FX-2 ✓): la deuda en euros baja, y eso es un beneficio.

---

#### O-6 · Un préstamo sin desglose de vencimientos no se reclasifica y el balance sale mal — **D5, R-RC-4**

**Defecto.** R-RC-4 es prudente para una factura, pero destructiva para un préstamo. Un préstamo bancario se registra como una única línea de `170` sin `dueDate`, o con el `dueDate` del **vencimiento final**. En el primer caso no se reclasifica nada; en el segundo, todo queda a largo. En los dos, el balance presenta **cero** en «Deudas con entidades de crédito a corto plazo» cuando lo correcto es el principal a amortizar en los doce meses siguientes al cierre (norma 6ª de elaboración de las cuentas anuales). Un auditor lo rechaza sin discusión: es la reclasificación más comprobada de un balance de PYME.

**Corrección.** Dos vías, y hay que elegir una antes de T-9:

1. **Preferida:** el alta de un préstamo emite **una línea de `170` por vencimiento de principal** (mismo patrón que la decisión 6 de E3 §6.6 para facturas a plazos), tomadas del cuadro de amortización del préstamo. La reclasificación funciona entonces sin cambios.
2. **Mínima aceptable:** una posición de `17x` o `52x` sin desglose de vencimientos hace que el paso `RECLASIFICACION_VENCIMIENTOS` salga **FAIL bloqueante** —no WARN— con el mensaje «declare el cuadro de vencimientos de la deuda X». Dejarlo en `unknownMaturity` como una lista informativa es firmar un balance mal clasificado.

---

#### O-7 · Los seis pares sembrados de `ReclassificationPair` son insuficientes — **D5.2**

**Defecto.** Se siembran 170↔520, 171↔521, 173↔523, 174↔524, 252↔542, 253↔543. Faltan los pares que cualquier PYME usa, y sin ellos el saldo se queda donde estaba: no hay error visible, hay un balance mal clasificado en silencio.

**Corrección — pares mínimos a sembrar** (además de los seis):

| Largo plazo | Corto plazo | Concepto |
|---|---|---|
| `160`, `161`, `162`, `163` | `510`, `511`, `512`, `513`, `514` | Deudas con partes vinculadas |
| `172` | `522` | Deudas transformables en subvenciones |
| `175` | `525` | Efectos a pagar |
| `176` | `526` *(no confundir con dividendo activo a pagar; usar la subcuenta que el plan de la org tenga)* | Otras deudas |
| `180` | `560` | Fianzas recibidas |
| `185` | `561` | Depósitos recibidos |
| `250` | `540` | Inversiones financieras en instrumentos de patrimonio |
| `251` | `541` | Valores representativos de deuda |
| `254` | `544` | Créditos a socios y administradores |
| `258` | `548` | Imposiciones a plazo |
| `260` | `565` | Fianzas constituidas |
| `265` | `566` | Depósitos constituidos |

La siembra debe hacerse **sólo donde ambas cuentas existan y sean postables** en el plan de la organización, con WARN de Auditoría en el resto (patrón ya usado en M4).

---

#### O-8 · La reversión de la reclasificación rompe la numeración de la apertura — **D5.5, Q-11b**

**Defecto.** «Se revierte con fecha de apertura del ejercicio siguiente» no dice **antes o después de T-28**. Si se postea antes, el asiento `OPENING` deja de ser el `entryNumber = 1` (regla N-1 de E3 §2.1) y **I-E9-14** («apertura = cierre línea a línea») falla, porque la apertura ya no reproduce el cierre: reproduce el cierre desreclasificado.

**Corrección.** Secuencia obligatoria, escrita en `closeFiscalYear`:

| Orden | Fecha | Asiento | `entryNumber` |
|---|---|---|---|
| último de N | 31/12/N | **T-27** `CIERRE_EJERCICIO` — con los saldos **ya reclasificados** | último de N |
| 1.º de N+1 | 01/01/N+1 | **T-28** `APERTURA_EJERCICIO` — espejo exacto de T-27 | **1** |
| 2.º de N+1 | 01/01/N+1 | **contra-asiento de T-32** (T-21, `reversesEntryId` → T-32) | **2** |

Así el balance a 31/12/N es el reclasificado (que es el que se formula), I-E9-14 se cumple, y el ejercicio N+1 arranca midiendo desde su propio cierre.

---

#### O-9 · La base de la regularización de prorrata está mal definida — **D4.3, R-IVA-12, Q-7**

**Defecto.** «`ajuste = deducido_definitivo − deducido_provisional` sobre la cuota soportada **deducible** del año». Si «deducible» se lee como «lo ya deducido», el motor aplica la diferencia de porcentajes a una base ya prorrateada y el ajuste sale corto.

**Corrección.** `ajuste = trunc(cuotaProrrateableCents × definitivaBps / 10000) − trunc(cuotaProrrateableCents × provisionalBps / 10000)`, donde `cuotaProrrateableCents` es la **cuota soportada del año sometida a prorrata**: excluye las cuotas 100 % deducibles por afectación exclusiva, las no deducibles por naturaleza (art. 96 LIVA) y las de **bienes de inversión** (art. 107, fuera de v1).

*(ejemplo)* `cuotaProrrateable = 100 000`; provisional 8 000 bps; numerador `8 700 000`, denominador `10 000 000` ⇒ `pct = ceil(8 700 000 × 100 / 10 000 000) = 87` ⇒ `definitivaBps = 8 700`.

| Cálculo | Resultado |
|---|---|
| Deducible definitivo `trunc(100 000 × 8700/10000)` | `87 000` |
| Deducido provisional `trunc(100 000 × 8000/10000)` | `80 000` |
| **Ajuste correcto** | **`+7 000`** |
| Ajuste con la lectura errónea `(87 % − 80 %) × 80 000` | `5 600` — **error de `1 400`** |

Asiento: `472 (D) 7 000 / 639 (H) 7 000`. Caso simétrico con definitiva `7 500` bps: ajuste `−5 000` ⇒ `634 (D) 5 000 / 472 (H) 5 000`. Casilla 44 = el ajuste **con signo**.

El criterio 9 de §12 confirma bien el redondeo (`8 700 001 / 10 000 000` ⇒ 87,00001 % ⇒ **88 %** ⇒ `8 800` bps): eso es el art. 104.Dos.2ª aplicado correctamente.

---

#### O-10 · El numerador y el denominador de la prorrata no tienen regla de derivación — **D4.2/4.4**

**Defecto.** `ProrrataYear.numeratorCents` y `denominatorCents` se guardan «como evidencia recomputable» e **I-E9-10 los recalcula**… pero no existe la función que los calcula. Sin regla, o son un dato tecleado (y el invariante es tautológico) o el motor los inventará.

**Corrección.** Derivación escrita, desde el **libro registro de facturas emitidas** del año natural (art. 104.Dos.1ª LIVA), en importes **sin IVA**:

| Término | Contenido |
|---|---|
| **Numerador** | Entregas y prestaciones **con derecho a deducción**: sujetas y no exentas, exportaciones y asimiladas, entregas intracomunitarias exentas (art. 25), y las exenciones «plenas» del art. 94.Uno |
| **Denominador** | Numerador **+** operaciones **sin** derecho a deducción (exenciones limitadas del art. 20) |
| **Excluido de ambos** (art. 104.Tres) | Entregas de **bienes de inversión** utilizados; operaciones **inmobiliarias o financieras no habituales**; autoconsumos del art. 9.1º.c) y d); operaciones realizadas **fuera** del territorio de aplicación desde establecimientos no situados en él; el propio IVA |

Toda exclusión debe ser **marcable en el documento** (una clave de operación en el libro registro), no deducida por el motor. Si la organización no ha marcado nada, el resultado sale `INFO` con la lista de documentos sin clasificar, **nunca** un porcentaje. Denominador 0 ⇒ `INFO`, como ya dice D4.2 (correcto).

---

#### O-11 · El asiento 634/639 tiene que caer dentro del último periodo de IVA y antes de T-23 — **D4.3, R-IVA-12**

**Defecto.** «La contrapartida es 472 para que la última liquidación la absorba» describe la intención, no la regla. Si el asiento se postea **después** de T-23 del cuarto trimestre, o si su línea de `472` no lleva el `ivaPeriod` de ese periodo, T-23 no lo barre, `472` queda con saldo al cierre y la casilla 44 no cuadra con el asiento.

**Corrección.** Tres condiciones verificables:

1. `closeProrrataYearAction` sólo se admite **antes** de `settleVatAction` del último periodo del año, y la acción de liquidar el último periodo **exige** que la prorrata del año esté cerrada (paso propio del checklist, bloqueante).
2. La línea de `472` del asiento lleva `ivaPeriod` = último periodo del año (art. 105.Uno LIVA: la regularización se practica *en la última declaración-liquidación del año natural*).
3. **Invariante nuevo I-E9-10b**: `ProrrataYear.adjustmentCents` = movimiento neto de `634`/`639` del año = componente de `472` del asiento de regularización, y ese asiento tiene `ivaPeriod` = último periodo. Tolerancia 0.

Y una regla que falta en D4.1: la **provisional de N+1 es la definitiva de N** (art. 105.Dos LIVA), fijada automáticamente por la misma acción — con la excepción de que el sujeto pasivo solicite un porcentaje distinto a la Administración, que se declara como dato, no se deduce.

---

#### O-12 · Bienes de inversión: la casilla vacía no puede convivir con un cierre en verde — **§1, D4.5, Q-8**

**Defecto.** «Casilla 43 vacía con el motivo escrito» es correcto como presentación, pero el cierre sigue avanzando y el sello puede salir `VALIDADO AUTOMÁTICAMENTE` sobre un ejercicio cuyo 303 del último periodo es incorrecto.

**Corrección.** Guardia determinista en `closingChecklist`:

```
si  existe año Y ∈ [N−8, N] con prorrataBps(Y) ≠ 10000
y   existe alta de cuenta de grupo 2 con coste ≥ 300 506 céntimos en [N−8, N]
y   |prorrataBps(N) − prorrataBps(año de alta)| > 1000        // diez puntos, art. 107.Uno
⇒   paso PRORRATA_DEFINITIVA = FAIL, blocking = true
    motivo de sello REGULARIZACION_BIENES_INVERSION_PENDIENTE
    la liquidación del último periodo NO se postea
```

Ventana de **cuatro** años (nueve para terrenos y edificaciones, art. 107.Tres), umbral del art. 108 y diferencia de más de diez puntos. Con esa guardia, dejar el art. 107 para E10 es defendible; sin ella, no.

---

#### O-13 · El mapa del 303 no permite rellenar el modelo: la cadena 46 → 71 está rota — **§3.4, Q-10**

**Defecto.** El mapa entregado ofrece 45 y 46 y salta a 67 y 71. Entre medias está todo lo que convierte el resultado del régimen general en el resultado de la liquidación, y sin ello el usuario no puede trasladar nada.

**Corrección — casillas que E9 debe ofrecer en v1** (régimen general, sin recargo de equivalencia, sin simplificado, sin REAGP):

| Bloque | Casillas | Origen |
|---|---|---|
| Devengado, régimen general | `01-02-03` (4 %) · `04-05-06` (10 %) · `07-08-09` (21 %) | Libro de **emitidas**, base y cuota por tipo de `TaxRate` |
| Adquisiciones intracomunitarias | `10` base · `11` cuota | Libro de **recibidas**, `operationKey = AIB` |
| Inversión del sujeto pasivo | `12` base · `13` cuota | Libro de **recibidas**, `operationKey = ISP` |
| Modificación de bases y cuotas | `14` base · `15` cuota | Rectificativas de venta (`rectificationDelta` de E8) |
| **Total cuota devengada** | `27` | `03+06+09+11+13+15` (+ recargo, no soportado ⇒ 0) |
| Deducible, interiores corrientes | `28` base · `29` cuota | Recibidas corrientes, cuota **deducible** (incluye la soportada por **ISP**) |
| Deducible, interiores **bienes de inversión** | `30` · `31` | Recibidas de grupo 2. **Debe ofrecerse**: separarlas no depende del art. 107 |
| Importaciones corrientes | `32` · `33` | `docKind = DUA_IMPORTACION`, base del DUA |
| Importaciones de bienes de inversión | `34` · `35` | DUA sobre grupo 2 |
| AIB corrientes | `36` · `37` | AIB deducible |
| AIB de bienes de inversión | `38` · `39` | AIB de grupo 2 |
| Rectificación de deducciones | `40` · `41` | Rectificativas de compra |
| Regularización bienes de inversión | `43` | **Vacía con motivo** (O-12) |
| Regularización prorrata definitiva | `44` | `prorrataRegularization`, con signo (O-9) |
| **Total a deducir** | `45` | `29+31+33+35+37+39+41+43+44` |
| **Resultado régimen general** | `46` | `27 − 45` |
| Informativas obligatorias | `59` entregas intracomunitarias · `60` exportaciones y asimiladas · `61` operaciones no sujetas o con ISP con derecho a deducción | Libro de emitidas por clave de operación |
| **RECC** (sólo si el régimen está activo) | `62`/`63` importes de las operaciones conforme al art. 75 · `74`/`75` importes conforme al art. 163 *terdecies* | Libro con las columnas del art. 61 *decies* RIVA |
| **Cadena hasta el resultado** | `64` suma de resultados · `65` % atribuible al Estado (100 salvo régimen foral) · `66` atribuible al Estado · `67` cuotas a compensar de periodos anteriores · `69` resultado · `70` a deducir (declaración anterior del mismo periodo) · `71` **resultado de la liquidación** | Derivadas; `71` = importe del asiento T-23 |

**Casillas que NO deben ofrecerse en v1, y hay que decirlo en pantalla:** `16` a `26` (recargo de equivalencia), `42` (compensaciones REAGP), `47` a `58` (régimen simplificado), `68` (regularización del art. 80.Cinco.5ª). Y el **modelo 390** queda fuera, como ya declara §1.

La identidad `casilla 71 = importe del asiento T-23` sólo es cierta una vez existen 64, 66, 67, 69 y 70; tal como está el mapa, el invariante que la comprueba no puede escribirse.

---

#### O-14 · RECC rompe los tres puentes al 303 (I-E8-15a/c) y I-E9-8a — **D8.3, R-IVA-15, Q-9**

**Defecto.** El libro registro de facturas emitidas anota la factura **en su expedición** por la cuota íntegra (art. 63 y 61 *decies* RIVA), mientras que bajo RECC la cuenta `477` sólo recoge la parte **cobrada**. I-E8-15c (`Σ477 = Σ` repercutida del libro) y I-E9-8a (`4750 = Σ477 − Σ472 deducible`) **fallan por diseño** en toda organización acogida, y fallan también en la del destinatario no acogido que compra a un proveedor RECC. Un invariante que falla por hacer lo correcto es peor que no tenerlo (lección N-1 de E7, otra vez).

**Corrección.** Reformular los puentes con las cuentas de pendiente incluidas:

| Invariante | Enunciado corregido |
|---|---|
| **I-E8-15c′** | `Σ 477 + Σ 4778 = Σ` cuota repercutida del libro de emitidas del periodo (**+** devengada por ISP/AIB de recibidas) |
| **I-E8-15a′** | `Σ 472 + Σ 4728 = Σ` cuota deducible del libro de recibidas del periodo |
| **I-E9-8a′** | Resultado del periodo = `Σ 477` **efectivamente devengado** − `Σ 472` **efectivamente deducible**, y tras T-23 los saldos de `472` y `477` del periodo quedan en **0** — pero `4728` y `4778` **conservan saldo** y no se barren |

Y el paso `IVA_LIQUIDADO` del checklist debe verificar, además, que **no queda ninguna factura RECC del año N−1 sin devengar a 31/12** (regla del art. 163 *terdecies*).

---

#### O-15 · RECC: falta la regla del cobro o pago parcial — **D8.3, R-IVA-15**

**Defecto.** «Al cobrar, `4778 → 477`» no dice **cuánto**. El devengo bajo RECC es proporcional al importe cobrado, y un cobro parcial devenga la parte de cuota que le corresponde.

**Corrección.** `cuotaDevengada = trunc(cobroCents × cuotaTotalCents / totalFacturaCents)`, con el **residuo al último cobro** (misma convención que R-AM-2 y R-PE-2), y un CHECK de que `Σ cuotas devengadas = cuota total` cuando la factura queda saldada o llega el 31/12 del año siguiente.

*(ejemplo)* factura base `1 000 000`, IVA 21 % `210 000`, total `1 210 000`. Cobro parcial de `500 000`:

| Cuenta | Debe | Haber |
|---|---|---|
| `572` Banco | 500 000 | |
| `430` Clientes | | 500 000 |
| `4778` IVA repercutido pendiente de devengo | 86 776 | |
| `477` IVA repercutido | | 86 776 |

`trunc(500 000 × 210 000 / 1 210 000) = 86 776`. Al saldar el resto, `4778` queda en cero exacto por el residuo.

---

#### O-16 · REDEME sin el diferimiento del IVA a la importación declara mal el DUA — **D8.5, R-IVA-14**

**Defecto.** R-IVA-14 afirma que el DUA «**no genera 477**». Es cierto en el régimen ordinario, donde la cuota la ingresa el importador en la Aduana. Pero D8 habilita **REDEME**, y una organización con periodo mensual puede optar por el **diferimiento del ingreso del IVA a la importación** (art. 167.Dos LIVA y art. 74.1 RIVA): entonces la cuota **no** se paga en Aduana, se **incluye en el 303** como cuota devengada (casilla `77`, «IVA a la importación liquidado por la Aduana pendiente de ingreso») y se deduce simultáneamente en `32-33`. Contabilizar el DUA sin devengo en una organización con diferimiento produce una autoliquidación con menos cuota devengada de la debida.

**Corrección.** `VatRegimePeriod` gana `importDeferral Boolean` (es una opción con vigencia anual, encaja en la tabla fechada) y T-29 se bifurca:

| Modalidad | Asiento *(ejemplo: base DUA `12 000 000`, aranceles `500 000`, cuota `2 520 000`)* |
|---|---|
| **Ordinaria** | `600/2xx (D) 500 000` aranceles · `472 (D) 2 520 000` · `410` agente de aduanas o `572 (H) 3 020 000` |
| **Con diferimiento** | `600/2xx (D) 500 000` · `472 (D) 2 520 000` · `477 (H) 2 520 000` · `410/572 (H) 500 000` — casillas `77` y `32-33` |

Y la casilla `77` entra en el mapa de O-13 cuando `importDeferral = true`. El resto de R-IVA-14 es correcto: la base es la del DUA (valor en aduana + aranceles + gastos hasta el primer lugar de destino, art. 83.Uno LIVA), **no** la de la factura del proveedor, y los aranceles son mayor coste (NRV 10ª.1 y 2ª.1). I-E9-22 está bien planteado.

---

#### O-17 · El orden de los asientos de cierre está mal en el tramo de ajustes — **§3.8, Q-14**

**Defecto.** El orden propuesto reclasifica **antes** de reconocer las diferencias de cambio y el valor actual. Consecuencia: la reclasificación se calcula sobre importes que después cambian, y el asiento de diferencias de cambio acaba moviendo `173` (ya reclasificado) por un delta calculado sobre la posición pre-reclasificación. `Σ largo + Σ corto` sigue cuadrando (I-E9-16 pasa), pero **el importe clasificado como corriente o no corriente es erróneo por el importe del ajuste**, que es justo lo que la reclasificación existe para evitar. Además faltan tres pasos del tramo fiscal.

**Corrección — orden completo:**

| # | Paso | Asiento | Por qué ahí |
|---|---|---|---|
| 1 | Recurrentes al día: amortización, periodificaciones, cuotas fijas | T-14, T-16, T-18, IMPORTE_FIJO | Son devengo del ejercicio, no ajuste |
| 2 | Devengo RECC del 31-12 del año N−1 | `4778→477`, `4728→472` | Antes de liquidar el periodo (O-14) |
| 3 | **Regularización de prorrata definitiva** | `472/639` o `634/472` | Antes de T-23 del último periodo (O-11) |
| 4 | **Liquidación del último periodo de IVA** | **T-23** | Deja 472/477 a cero |
| 5 | **Valor actual del aplazamiento** | **T-31** (con el tratamiento de O-1) | En la divisa del pasivo, **antes** de convertir |
| 6 | **Diferencias de cambio** | **T-30** | Sobre las posiciones ya ajustadas por valor actual |
| 7 | **Reclasificación por vencimiento** | **T-32** | **Última** de las de balance: opera sobre importes definitivos |
| 8 | **Impuesto sobre beneficios** | **T-25** | Después de **todos** los movimientos de 6/7 (art. 10.3 LIS) |
| 9 | Regularización del resultado | **T-26** | Barre 6/7, incluida `6300`, contra `129` |
| 10 | Cierre | **T-27** (último de N) | Saldos ya reclasificados |
| 11 | Apertura | **T-28** (nº 1 de N+1) | Espejo exacto (I-E9-14) |
| 12 | Contra-asiento de la reclasificación | T-21 de T-32 (nº 2 de N+1) | O-8 |

Faltan además, y el checklist debería recogerlos aunque no se automaticen: **regularización de existencias / obra en curso** (`61x`/`71x`, `33x`), **deterioro de créditos comerciales** (`694`/`490`, con el criterio del art. 13.1 LIS de seis meses como referencia fiscal), **provisiones** (`14x`) e **imputación de subvenciones a resultados** (`746`/`130`). Para una empresa de proyectos, la obra en curso no es opcional.

---

#### O-18 · Falta la distribución del resultado: `129` se queda vivo para siempre — **alcance de E9**

**Defecto.** E9 lleva el resultado a `129` (T-26) y lo arrastra por el cierre y la apertura. **Nada lo distribuye.** El ejercicio N+1 abre con `129` poblado, el balance muestra indefinidamente «Resultado del ejercicio» de un año que ya pasó, la reserva legal nunca se dota y el dividendo nunca se registra. Es una omisión de ciclo, no un detalle: sin ella el patrimonio neto es incorrecto desde el segundo ejercicio.

**Corrección.** Plantilla nueva `DISTRIBUCION_RESULTADO`, disparada por `setAccountsApprovalAction` al marcar **`APROBADAS`**, con la **fecha de la junta general** (art. 164 LSC), rol ADMIN, propuesta editable y `AuditLog`. Reglas:

| Destino | Cuenta | Regla |
|---|---|---|
| Reserva legal | `112` | `min(10 % del beneficio, 20 % del capital social − saldo actual de 112)` — art. 274 LSC. Obligatoria y calculada, no propuesta |
| Reservas voluntarias | `113` | El resto que la junta acuerde |
| Remanente | `120` | Lo no aplicado |
| Dividendo | `526` Dividendo activo a pagar | Sólo si hay beneficio distribuible (art. 273 LSC: reservas indisponibles y gastos de I+D cubiertos) |
| **Pérdida** | `121` Resultados negativos de ejercicios anteriores | `121 (D) / 129 (H)` |

*(ejemplo)* beneficio `1 497 322`; capital `3 000 000`; saldo previo de `112` = `400 000` ⇒ límite `600 000`, dotación `min(trunc(0,10 × 1 497 322) = 149 732 ; 200 000) = 149 732`; dividendo acordado `500 000`.

| Cuenta | Debe | Haber |
|---|---|---|
| `129` Resultado del ejercicio | 1 497 322 | |
| `112` Reserva legal | | 149 732 |
| `113` Reservas voluntarias | | 847 590 |
| `526` Dividendo activo a pagar | | 500 000 |

Al pagarlo: `526 (D) 500 000 / 4751 H.P. acreedora por retenciones (H) 95 000 / 572 (H) 405 000` *(ejemplo, retención 19 %, art. 101 LIRPF)*.

**Invariante nuevo I-E9-23:** ningún ejercicio con `accountsApprovalStatus = APROBADAS` mantiene saldo en `129` del ejercicio anterior; y `Σ` de la distribución = saldo de `129` regularizado, tolerancia 0.

---

#### O-19 · I-E9-5 no es computable: el saldo de `28x` no es atribuible a un activo — **§5.1**

**Defecto.** I-E9-5 exige que, **por activo**, la suma de líneas de dotación en el diario coincida con las cuotas del cuadro y que el saldo de `28x` no supere la base amortizable. Pero `2811` es **una cuenta compartida por todos los activos de su clase**: nada en `JournalLine` dice a qué `FixedAsset` pertenece una dotación. El invariante, tal como está escrito, no se puede evaluar; se evaluará por agregado y dejará pasar exactamente los errores que busca (un activo sobreamortizado compensado por otro infraamortizado).

**Corrección.** Una de las dos, decidida antes de T-3:

1. **Preferida:** `JournalLine.fixedAssetId` (FK compuesta por tenant, `NULL` salvo en líneas de `68x`/`28x`/`671`/`771`). Es aditiva, indexable y permite el drill-down «cuota del cuadro → asiento» que §6 promete para `/settings/assets`.
2. **Alternativa:** una **subcuenta de `28x` por activo**, resuelta por `resolvePostable`. Funciona, pero infla el plan de cuentas y complica el balance por epígrafe.

Sin una de las dos, I-E9-5 y el criterio 24 (error inyectado que debe «nombrar el activo») son irrealizables.

---

#### O-20 · La reapertura rompe las reglas de numeración N-1/N-5 — **D1.2, §3.8**

**Defecto.** E3 fija que `OPENING` es el asiento **nº 1** del ejercicio y `CLOSING` el **último** (N-1…N-7, §2.1, con comprobación explícita en las validaciones de T-27/T-28). La reapertura postea el contra-asiento de T-27 **después** de T-27 en el ejercicio N, y el de T-28 después de T-28 en N+1. Al volver a cerrar, el nuevo T-27 sí queda el último de N, pero el nuevo T-28 recibe `entryNumber = 4` o superior en N+1. La comprobación de E3 falla y el cierre nuevo se bloquea a sí mismo.

**Corrección.** Reformular las reglas de numeración en términos de **asiento vivo**, no de posición absoluta:

- N-1′: el asiento `OPENING` **no anulado** de un ejercicio es el de menor `entryDate` del ejercicio y tiene fecha del primer día. Deja de exigirse `entryNumber = 1`.
- N-5′: el asiento `CLOSING` **no anulado** es el de mayor `entryDate` del ejercicio y tiene fecha del último día.
- La numeración sigue siendo correlativa y sin huecos (art. 29.1 CCom): un contra-asiento **consume su número**, como ya establece N-4.

Y el aviso de §3.8 —listar los asientos de N+1 posteriores a la apertura y exigir doble confirmación— debe ser **bloqueante** si alguno de ellos es un `CLOSING`: reabrir N con N+1 ya cerrado exige reabrir antes N+1.

---

#### O-21 · La reapertura no revierte los ajustes de cierre y al recerrar se duplica el impuesto — **D1.2**

**Defecto.** Se revierten T-28, T-27 y T-26. **T-25 no.** Al volver a cerrar, el asistente vuelve a postear el impuesto sobre beneficios y la `6300` queda con el doble, con `4752` duplicado y una base imponible que ya no coincide con nada. Los demás ajustes son idempotentes por construcción —T-30 recalcula `Δ` sobre una posición ya ajustada y da cero; T-32 encuentra los saldos ya reclasificados; los recurrentes chocan contra el índice único—, pero **T-25 no lo es**.

**Corrección.** La reapertura revierte, en orden inverso: **T-28 → T-27 → T-26 → T-25**. Los pasos 5, 6 y 7 del cierre (valor actual, diferencias de cambio, reclasificación) **no** se revierten, y el `ClosingRun` reabierto marca sus pasos como `PENDIENTE_RECOMPUTO` para que el asistente los reevalúe y sólo postee delta si lo hay. `I-E9-21` se amplía: tras la reapertura, `129 = 0`, `6300 = 0` y el saldo de **cada** cuenta de los grupos 1 a 7 vuelve al previo al cierre.

---

#### O-22 · Activos de importe pequeño generan cuotas de cero céntimos — **D2.2, R-AM-2**

**Defecto.** `q = trunc(base / n)` vale **0** cuando `base < n`. Un activo de `20` céntimos y 36 meses produce 35 ocurrencias de importe cero y una de `20`. Un asiento de importe cero viola C-1 y el refuerzo de I1 acordado en E3 §6.5 (≥ 1 línea con debe > 0 y ≥ 1 con haber > 0) y, si el motor lo saltara sin dejar rastro, quedaría un hueco de devengo invisible.

**Corrección.** Regla explícita en R-AM-2 y R-PE-2: **una fila del cuadro con cuota 0 no genera asiento**; la ocurrencia se registra como `OMITIDA` con motivo `CUOTA_CERO` y el importe se acumula a la siguiente fila con cuota > 0. Así el cuadro sigue sumando la base, no hay asiento vacío y la omisión es visible (G-4 ya exige motivo). Mismo tratamiento para `accrualSchedule`.

---

### No bloqueantes

#### O-23 · La amortización fiscal debe declararse fuera del diario — **D2, Q-3**

Escribir en el diseño y en la UI: el cuadro es **contable** (NRV 2ª.2.1); los coeficientes del art. 12.1 LIS son una **sugerencia** al dar de alta, no un dato del motor; la **libertad de amortización** (arts. 12.3 y 102 LIS) y la amortización acelerada **no se contabilizan** y generan diferencias temporarias imponibles (`479` contra `6301`), que son E10. Sin esta declaración, un usuario intentará meter la libertad de amortización en el cuadro y ensuciará el resultado contable que el art. 10.3 LIS toma como punto de partida.

#### O-24 · Automatizar baja y venta con las cuentas correctas — **R-AM-6, Q-5**

Plantillas nuevas según §Q-5, con `543`/`253` (nunca `430`), dotación previa de la amortización hasta el mes de baja inclusive, y aviso del art. 110 LIVA cuando el elemento sea bien de inversión dentro del periodo de regularización.

#### O-25 · 567/568 por tipo de interés efectivo cuando el principal varía — **D3.1, Q-6**

Regla escrita en R-PE-1 y WARN cuando `basis = DIAS` sobre 567/568 con horizonte > 12 meses o principal decreciente.

#### O-26 · T-25 incompleto: cuenta, cancelación de `473` y pregunta por lo diferido — **Q-12**

`6300` (no `630`); T-25 **debe** cancelar el saldo de `473` por retenciones soportadas y pagos fraccionados; paso del checklist que pregunta por diferencias temporarias, BIN y deducciones, con motivo de sello `IMPUESTO_DIFERIDO_NO_RECONOCIDO` (NRV 13ª).

#### O-27 · Separar las subcuentas de `4751` por modelo — **§3.4, retenciones**

`4751` recibe hoy las retenciones del modelo **111** (rendimientos del trabajo y de actividades económicas) y las del **115** (arrendamientos de inmuebles urbanos, art. 100 RIRPF), y también las del **123** si hay dividendos (O-18). Con una sola cuenta, el puente I-E8-17 no puede repartir el saldo entre modelos y el paso `RETENCIONES_LIQUIDADAS` no es verificable. Subcuentas por modelo, mapeadas por `AccountKey` (`IRPF_A_PAGAR_111`, `IRPF_A_PAGAR_115`, `IRPF_A_PAGAR_123`), nunca códigos escritos.

#### O-28 · Redacción de I-E9-4 con revisiones — **§5.1**

«Σ cuotas del cuadro = coste − valor residual» deja de ser cierta tras una revisión que cambie el residual o capitalice una mejora. Enunciado correcto: **`Σ cuotas del cuadro vigente = coste + Σ mejoras capitalizadas − valor residual vigente`**, ninguna cuota negativa, y la última es la que cuadra.

#### O-29 · Faltan pasos del cierre que un auditor busca primero — **§3.8**

Ver el checklist de §4. Como mínimo hay que añadir al `ClosingStep`: existencias/obra en curso, deterioro de créditos, provisiones, subvenciones, arqueo de caja, cuentas puente a cero (I-E7-16 ya lo mide) y periodo medio de pago (art. 262 LSC y Ley 15/2010, mención obligatoria en la memoria).

#### O-30 · Mes entero: alta y baja en el mismo mes cuentan dos meses — **R-AM-3/R-AM-6**

Con «mes entero desde la puesta en servicio» y «hasta el mes de la baja inclusive», un activo en servicio el 31/01 y dado de baja el 01/02 amortiza dos meses. Es inmaterial y aceptable, pero debe estar escrito en la norma de valoración y ser el criterio uniforme; alternativamente, excluir el mes de la baja cuando ésta ocurre antes del día 15. No cambiar el criterio a mitad de vida de un activo.

---

## 3. Revisión de los invariantes I-E9-1 … 22

| ID | Veredicto | Nota |
|---|---|---|
| I-E9-1a/1b | **Correcto** | La idempotencia por índice único es la única defensa real frente a la doble generación |
| I-E9-2 | **Correcto** | |
| I-E9-3 | **Correcto** | El sello del cuadro es lo que permite no almacenarlo (ADR-0003) |
| I-E9-4 | **Corregir** | O-28 |
| I-E9-5 | **No computable** | O-19: sin `fixedAssetId` en la línea no hay atribución por activo |
| I-E9-6 / I-E9-7 | **Correcto** | I-E9-7 es el que caza la periodificación olvidada |
| I-E9-8a | **Corregir** | O-14: falla en RECC |
| I-E9-8b | **Correcto** | Comparar los dos caminos antes de retirar `quarterOf` es la decisión acertada |
| I-E9-9 | **Correcto** | |
| I-E9-10 | **Corregir** | O-9 (base) y O-10 (numerador/denominador). Añadir **I-E9-10b** (O-11) |
| I-E9-11 / I-E9-12 / I-E9-13 | **Correcto** | |
| I-E9-14 | **Correcto**, condicionado a O-8 | |
| I-E9-15 | **Correcto** | |
| I-E9-16 | **Insuficiente** | Comprueba la suma cero, no la **corrección de la clasificación**. Añadir: toda posición reclasificada tiene `dueDate`, y ninguna posición con `dueDate ≤ corte + threshold` quedó en la cuenta de largo. Y O-6 |
| I-E9-17 | **Corregir** | O-4 (universo monetario) y O-5 (tasa efectiva sellada) |
| I-E9-18 | **Correcto** | Es el que evita que la diferencia de cambio se cuente como partida en tránsito |
| I-E9-19 | **Corregir** | O-1: el enunciado debe ser `descuento inicial = Σ intereses implícitos de toda la vida` |
| I-E9-20 / I-E9-21 | **Correcto / ampliar** | I-E9-21 debe abarcar grupos 1–7 y exigir `129 = 0` y `6300 = 0` (O-21) |
| I-E9-22 | **Correcto**, ampliar | Con diferimiento, el DUA **sí** genera `477` (O-16) |

**Invariantes que faltan** y hay que añadir:

| ID propuesto | Enunciado | Tol. |
|---|---|---|
| **I-E9-10b** | El asiento de regularización de prorrata tiene `ivaPeriod` = último periodo del año y se postea antes de su T-23; `adjustmentCents` = movimiento neto de 634/639 = componente de 472 del asiento | 0 |
| **I-E9-23** | Distribución del resultado: ningún ejercicio `APROBADAS` conserva saldo en `129` del anterior; `Σ` destinos = resultado regularizado; `112 ≥ min(10 % acumulado, 20 % del capital)` | 0 |
| **I-E9-24** | Ninguna línea con `original_currency` de una cuenta **no monetaria** entra en el barrido de diferencias de cambio | — |
| **I-E9-25** | Toda posición de `17x`/`52x` viva al cierre tiene desglose de vencimientos o está en `unknownMaturity` con motivo declarado por una persona | — |
| **I-E9-26** | RECC: ninguna factura del año N−1 conserva saldo en `4778`/`4728` después del 31/12 de N | 0 |

**Tolerancia 0.** Es correcta y **alcanzable** en todos los que comparan importes, porque las tres reglas de reparto (R-AM-2, R-PE-2, O-15) llevan el residuo a una fila determinada y no hay reparto por mayor resto en ningún punto de E9. No debe relajarse en ningún caso.

---

## 4. Checklist de cierre — el que firmaría un CFO

Los dieciséis pasos de `ClosingStep` cubren la mitad. Lista completa, con lo que E9 ya tiene marcado **(✓)** y lo que falta **(+)**:

| Bloque | Comprobación |
|---|---|
| **Integridad del diario** | ✓ Invariantes I1–I10 y I-E7/E8/E9 en PASS · ✓ Sin runs en FAIL · ✓ Sin documentos en `PROPOSED` · ✓ Almacén barrido · ✓ Ejercicio completo (doce meses) · **+** Σdebe = Σhaber **mes a mes** (I-E7-17, art. 28.1 CCom) · **+** Cuentas puente (`555`, `551`, `4749`) a cero (I-E7-16) · **+** Saldos contrarios a su naturaleza revisados (I-E7-15) |
| **Tesorería** | ✓ Conciliación bancaria de todas las cuentas · **+** Arqueo de caja firmado · **+** Confirmaciones bancarias de saldos y de deudas |
| **Devengo** | ✓ Recurrentes al día · ✓ Amortización al día · ✓ Periodificaciones al día · **+** Facturas pendientes de recibir (`4009`/`410`) · **+** Ingresos devengados no facturados (`4309`) · **+** Existencias / obra en curso (`33x`, `61x`/`71x`) · **+** Subvenciones imputadas (`746`/`130`) |
| **Valoración** | ✓ Diferencias de cambio reconocidas · ✓ Valor actual del aplazamiento · **+** Deterioro de créditos comerciales (`694`/`490`) · **+** Deterioro de inmovilizado (`691`/`291`) · **+** Provisiones (`14x`) y contingencias, con la memoria |
| **Presentación** | ✓ Reclasificación corriente / no corriente · **+** No compensación de partidas (art. 35.6 CCom) · **+** Periodo medio de pago a proveedores (art. 262 LSC, Ley 15/2010) |
| **Fiscal** | ✓ IVA liquidado en todos los periodos · ✓ Retenciones liquidadas (111, 115) · **+** Prorrata definitiva cerrada · **+** Bienes de inversión (O-12) · **+** RECC devengado a 31/12 · **+** Pagos fraccionados del IS conciliados con `473` · **+** Declaraciones informativas pendientes: 347, 349, 190, 390 (fuera del producto, pero el paso existe) |
| **Impuesto** | ✓ Impuesto sobre beneficios · **+** Diferencias temporarias, BIN y deducciones respondidas explícitamente |
| **Cierre y societario** | ✓ T-26 → T-27 → T-28 en una transacción · **+** Legalización de libros (art. 27 CCom, cuatro meses) · **+** Formulación (art. 253 LSC, tres meses) · **+** Junta general (art. 164 LSC, seis meses) · **+** **Distribución del resultado** (O-18) · **+** Depósito de cuentas (art. 279 LSC, un mes desde la aprobación) |
| **Analítica** | ✓ Liquidación de CECOs (E5) · ✓ I4/I5 en PASS |

---

## 5. Lo que un auditor rechazaría

Ordenado por lo primero que miraría:

1. **Un balance con «Deudas con entidades de crédito a corto plazo» en cero** teniendo préstamos vivos (O-6). Es la primera reclasificación que se comprueba y es la que más veces está mal en una PYME.
2. **Un patrimonio neto con el resultado de dos ejercicios distintos** en `129`, la reserva legal sin dotar y ningún acuerdo de distribución registrado (O-18). Incumple los arts. 273 y 274 LSC y hace que el PN presentado no sea el real.
3. **Una amortización acumulada que no se puede desglosar por activo** (O-19): sin ese desglose no hay prueba de detalle posible sobre el inmovilizado, que es el área con más horas de auditoría en este segmento.
4. **Un inmovilizado adquirido con pago aplazado a más de un año registrado por su nominal** (O-1). Es un error de valoración inicial, no una omisión de cierre, y arrastra el coste, la amortización de todos los ejercicios y el gasto financiero.
5. **Diferencias de cambio reconocidas sobre anticipos** (O-4): resultado inventado sobre una partida no monetaria.
6. **Una regularización de prorrata calculada sobre la base equivocada** (O-9) y un 303 con la casilla 43 vacía en una empresa con prorrata e inmovilizado (O-12): las dos son cifras declaradas ante la AEAT.
7. **Un asiento de impuesto sobre sociedades que no cancela `473`** (O-26): activo y pasivo simultáneamente sobrevalorados por el mismo importe, con compensación aparente en el resultado.
8. **Una reapertura que deja el impuesto duplicado** (O-21) o la numeración del diario incoherente (O-20), art. 29.1 CCom.
9. **Un cierre que no avanza el 31 de diciembre de 2028** porque el BCE no publicó tasa en domingo (O-5): no es un defecto contable, es un producto que no cierra el ejercicio.
10. **Un libro registro de RECC sin las columnas de cobro y pago** (art. 61 *decies* y *undecies* RIVA) y unos puentes al 303 que fallan por hacer lo correcto (O-14).

---

## 6. Qué se puede empezar a construir ya

Sin esperar a nada: **T-3** (esquema, añadiendo `JournalLine.fixedAssetId` de O-19, `Account.isMonetary` de O-4 y `VatRegimePeriod.importDeferral` de O-16), **T-5** (`lib/recurring/schedule.ts`), **T-6** y **T-7** con las correcciones O-22 y O-28, **T-19** (fixture), **T-20** y **T-21**.

Bloqueadas hasta que el ADR incorpore las correcciones y se firme: **T-8** (O-9…O-16), **T-9** (O-1…O-8), **T-10**, **T-13** (O-17, O-18, O-20, O-21) y todo lo que dependa de ellas.

---

*Documento del agente `experto-contable`. No modifica `docs/design/E9-cierre-recurrentes.md` ni `docs/adr/0016-*`: las correcciones las incorpora el `arquitecto` en T-2 antes de llevar el ADR a firma humana.*

---
---

# Ronda 2 — Re-validación del diseño (1 968 líneas) y de ADR-0016 (D1–D12)

> Verificación **observación por observación contra el texto real**, no contra el resumen del arquitecto. Fuentes releídas: `docs/design/E9-cierre-recurrentes.md` §§0, 3.2, 3.4, 3.5, 4.2–4.10, 6.1, 6.2, 7, 9, 11, 12, 13, 14 y `docs/adr/0016-cierre-recurrentes-y-fiscalidad-periodica.md` (D1–D12 completo), contrastadas con `seeds/npgc.csv` y `prisma/schema.prisma`.

## 7. Veredicto final

### **CONFORME CON OBSERVACIONES**

**Las treinta observaciones están cerradas** — las veintidós bloqueantes y las ocho no bloqueantes—, verificadas en el articulado y no sólo en la tabla de cambios. Las cinco decisiones declaradas NO CONFORMES en la ronda 0 (D4, D5, D6, D7, D8) están reescritas con el fondo correcto, no parcheadas: D7 traslada el descuento al **reconocimiento inicial** con las tres vías A/B/C y niega expresamente el uso de `AssetRevision`; D6 acota el universo a `LedgerAccount.isMonetary` y define la tasa de cierre como la última publicada dentro de una ventana; D5 crea `DebtSchedule` + T-37 y convierte la deuda sin desglose en **FAIL bloqueante**; D4 deriva numerador y denominador del libro con las exclusiones del art. 104.Tres **marcadas en el documento**, corrige la base del ajuste y cierra la cadena 46 → 71 del 303; D8 reformula los puentes como 15a′/15c′ y resuelve el cobro parcial y el diferimiento de importación. Las cuatro decisiones nuevas —**D9** orden, **D10** distribución, **D11** `fixedAssetId`, **D12** subcuentas de retenciones— cubren las tres omisiones de ciclo que la ronda 0 destapó.

Los invariantes pasan de 22 a **26**, con seis corregidos (⟳) y cuatro nuevos (✚); I-E9-5 deja de ser tautológico, I-E9-16 comprueba por fin la **corrección de la clasificación** y no sólo la suma cero, e I-E8-15a/c pasan a 15a′/15c′ para no fallar por hacer lo correcto. La tolerancia 0 se mantiene y es alcanzable: no queda ni un reparto por mayor resto en E9.

**Quedan tres puntos menores, todos de precisión y ninguno de criterio contable.** Se corrigen en el texto sin nueva ronda: R2-1 y R2-3 son erratas de código y de nomenclatura; R2-2 es una segunda fuente de verdad que ADR-0003 no permite. **T-2 puede llevar el ADR a firma humana incorporándolos.**

## 8. Las treinta observaciones, una a una

| # | Estado | Dónde queda cerrada (texto verificado) |
|---|---|---|
| **O-1** valor actual = valoración inicial | **CERRADA** | §4.7 encabezado y R-VA-1 con la tabla A/B/C; R-VA-2 (umbral derivado del 0,5 % del activo); ADR **D7.1/D7.2/D7.4**. Se niega explícitamente `AssetRevision` («cambio de estimación ≠ corrección de error») |
| **O-2** tipo mensual | **CERRADA** | R-VA-3 + `Organization.discountRateMonthlyMicroBps` (§3.2, línea 733, **sustituye** a `discountRateBps`); ADR D7.3. El ejemplo de 28 051 c está recogido |
| **O-3** `762` lado activo | **CERRADA** | R-VA-5; `AccountKey.INGRESOS_CREDITOS` (762); ADR D7.6 |
| **O-4** universo monetario | **CERRADA** | R-FX-2, `LedgerAccount.isMonetary` sembrado desde el seed, **I-E9-24**, `readFxPositions` acotado (§4.10); ADR D6.2. Exclusión expresa de `407`/`438` |
| **O-5** tasa de cierre | **CERRADA** | R-FX-5 (mayor `rateDate ≤ cutoff`, ventana de 7 días, `rateDate` sellada), firma de `fxClosingAdjustments` con `window`; I-E9-17; ADR D6.5 |
| **O-6** préstamos sin desglose | **CERRADA** | R-RC-4, `model DebtSchedule` + `debt_installments` (§3.2), **T-37**, G-17, **I-E9-25**, paso bloqueante `RECLASIFICACION_VENCIMIENTOS`, motivo `DEUDA_SIN_DESGLOSE`; ADR D5.3 |
| **O-7** pares de reclasificación | **CERRADA con reserva** | R-RC-7 y ADR D5.2: pasan de 6 a 18. **Ver R2-1**: dos códigos mal |
| **O-8** orden de la reversión | **CERRADA** | R-RC-6 con la tabla de `entryNumber` (T-27 → T-28 nº 1 → contra-asiento nº 2); ADR D5.6; criterio 17 |
| **O-9** base del ajuste de prorrata | **CERRADA** | R-IVA-13 con la fórmula exacta y la firma `prorrataRegularization({ prorrateableQuotaCents, … })`; I-E9-10; ADR D4.4. El contraste 7 000 / 5 600 está escrito |
| **O-10** numerador y denominador | **CERRADA** | R-IVA-12 con la tabla del art. 104.Dos/Tres y `prorrataTerms(book, year)`; exclusiones **marcadas**, nunca deducidas; `INFO` con lista si hay documentos sin clasificar; ADR D4.3 |
| **O-11** momento y `ivaPeriod` | **CERRADA** | R-IVA-15 y **I-E9-10b** (nuevo), incluida la fijación de `provisionalBps(N+1) = definitiveBps(N)`; ADR D4.6 |
| **O-12** guardia de bienes de inversión | **CERRADA** | R-IVA-16 con el pseudocódigo, ventana 4/9 años, umbral del art. 108 y diez puntos del art. 107.Uno; paso bloqueante `BIENES_DE_INVERSION`; motivo de sello; ADR D4.7 |
| **O-13** mapa del 303 | **CERRADA** | §4.4 tabla completa: 01-15, 27, 28-41, 43, 44, 45, 46, 59-61, 62/63 y 74/75, **64, 65, 66, 67, 69, 70, 71** y 77; y la lista de las que **no** se ofrecen (16-26, 42, 47-58, 68); ADR D4.8 |
| **O-14** puentes con 4728/4778 | **CERRADA** | §4.4 tabla de I-E8-15a′/15c′/I-E9-8a′; §6.2 registra la ruptura y su remedio; I-E9-11 e I-E9-8b amplían el universo a 4728/4778; ADR D8.6 |
| **O-15** cobro parcial RECC | **CERRADA** | R-IVA-19 con la fórmula, el residuo al último cobro y el ejemplo de 86 776 c; `reccAccrualOnCollection`; T-08/T-09 tocadas (§4.10); **I-E9-26**; ADR D8.3 |
| **O-16** diferimiento de importación | **CERRADA** | R-IVA-18 con las dos modalidades y su asiento; `VatRegimePeriod.importDeferral` + CHECK `⇒ MENSUAL` (M3); casilla 77; I-E9-22; ADR D8.8 |
| **O-17** orden de los asientos | **CERRADA** | §4.8 tabla de doce pasos con PV → FX → reclasificación y el impuesto tras todo movimiento de 6/7; ADR **D9.1** |
| **O-18** distribución del resultado | **CERRADA** | §4.9 completa con `legalReserveCents`, T-35, `profit_distributions`, G-16, **I-E9-23**, motivo `RESULTADO_SIN_DISTRIBUIR`, y el `557` de dividendo a cuenta que yo no había señalado; ADR **D10** |
| **O-19** atribución por activo | **CERRADA** | `JournalLine.fixedAssetId` + FK compuesta + índice (§3.2 línea 730), G-15, M2, I-E9-5 con `INFO` para el histórico, drill-down en `/settings/assets`, techo de rendimiento propio; ADR **D11** |
| **O-20** numeración por asiento vivo | **CERRADA** | §4.8 punto 5 (N-1′/N-5′), §6.2 fila «N-1 / N-5», migración M6; ADR D1.6 |
| **O-21** reversión de T-25 | **CERRADA** | §4.8 punto 4 (T-28 → T-27 → T-26 → **T-25**) y `PENDIENTE_RECOMPUTO` para los pasos 5-7; I-E9-21 ampliada a grupos 1-7 con `129 = 0` y `6300 = 0`; ADR D1.5/D1.8 |
| **O-22** cuota cero | **CERRADA** | **R-REC-8** con motivo `CUOTA_CERO` y acumulación a la fila siguiente; referida desde R-AM-2 y R-PE-2; octavo caso del fixture; R5 de riesgos; ADR D2.3 |
| **O-23** amortización fiscal fuera del diario | **CERRADA** | R-AM-9 y la sugerencia de coeficiente en la ficha del activo (§7) con la nota de que no se contabiliza; ADR D2.7 |
| **O-24** baja y venta automatizadas | **CERRADA** | R-AM-6/R-AM-7, T-33 y T-34, `disposalLines`, `543`/`253` con la prohibición expresa de `430`, aviso del art. 110 LIVA y del art. 20.Uno.22º; ADR D2.6 |
| **O-25** 567/568 por tipo efectivo | **CERRADA** | R-PE-6 con `DebtSchedule` y `basis = TIPO_EFECTIVO`, y WARN mientras tanto; ADR D3.6 |
| **O-26** T-25 completo | **CERRADA** | §4.10 fila T-25 (`6300`, cancelación obligatoria de `473`), paso `IMPUESTO_DIFERIDO_RESPONDIDO`, motivo `IMPUESTO_DIFERIDO_NO_RECONOCIDO`; ADR D9.2 |
| **O-27** subcuentas de `4751` | **CERRADA** | `AccountKey.IRPF_A_PAGAR_111/115/123`, paso `RETENCIONES_LIQUIDADAS` por subcuenta, §6.2 fila I-E8-17; ADR **D12** |
| **O-28** enunciado de I-E9-4 | **CERRADA** | R-AM-1 e I-E9-4 con «coste + Σ mejoras − residual vigente»; ADR D2.2 |
| **O-29** pasos que faltaban | **CERRADA** | §4.8: 41 pasos en nueve bloques, con los quince que yo eché en falta —existencias y obra en curso incluidas— y nueve bloqueantes; ADR D9.3 |
| **O-30** doble mes en alta y baja | **CERRADA** | R-AM-8: se acepta, **se escribe en la norma de valoración de la memoria** y no se cambia a mitad de vida; ADR D2.4 |

**Además, y sin que yo lo pidiera**, se han incorporado tres precisiones correctas: el aviso del **art. 122 LGT** con `FiscalYear.taxFilingStatus` cuando el modelo 200 ya se presentó; el mensaje de rechazo de la reapertura que **ofrece salida** en vez de decir «imposible»; y el `557` **dividendo activo a cuenta** cancelado en la distribución, que es justo donde se olvida.

## 9. Observaciones residuales (menores, sin tercera ronda)

#### R2-1 · Dos códigos incorrectos en los pares de reclasificación — R-RC-7 / ADR D5.2

`176 ↔ 52x` **no existe**: `176` es **«Pasivos por derivados financieros a largo plazo»** (verificado en `seeds/npgc.csv`), y su par corriente no está en el subgrupo 52 sino en **`5595` «Pasivos por derivados financieros a corto plazo»**. Un comodín `52x` no siembra nada o siembra un par falso. Y falta el único empréstito del PGC: **`177` «Obligaciones y bonos» ↔ `500` «Obligaciones y bonos a corto plazo»**.

**Corrección exacta**, sustituyendo la lista de R-RC-7 y D5.2:

| Sustituir | Por |
|---|---|
| `176 ↔ 52x` | **`176 ↔ 5595`** |
| *(ausente)* | **`177 ↔ 500`** |
| `16x ↔ 51x` | **`160↔510`, `161↔511`, `162↔512`, `163↔513`** — enumerados, porque el motor siembra pares, no familias. **`514`, `527` y `528` quedan fuera**: son *intereses a corto plazo* y **nacen ya corrientes**; reclasificarlos sería moverlos a una cuenta de largo que no les corresponde |

Con la enumeración, el recuento pasa de «dieciocho pares» a **veintitrés**: hay que actualizar la cifra en R-RC-7, en la tabla §0 y en ADR D5.2.

#### R2-2 · `Organization.capitalStockCents` es una segunda fuente de verdad — §3.2 línea 733 / ADR D10.3

La reserva legal se calcula sobre el capital social, y el capital social **está en el diario**: es el saldo acreedor de la cuenta **`100`**. Almacenarlo en `Organization` crea exactamente la divergencia que ADR-0003 prohíbe —una ampliación de capital contabilizada y no replicada en el campo deja la reserva legal mal dotada, y `I-E9-23` la validaría contra la cifra equivocada—.

**Corrección exacta.** `legalReserveCents` recibe `capitalStockCents` **derivado** del saldo de `100` a la fecha de la junta (clave `CAPITAL_SOCIAL` del mapa de la organización, nunca el código escrito). El campo se conserva **sólo** como valor de contingencia para organizaciones cuyo plan no tenga `100` mapeada, y su uso emite **WARN** nombrando la organización. I-E9-23 compara contra el **saldo del diario**, no contra el campo.

#### R2-3 · Nomenclatura del atributo monetario — §0 tabla O-4 frente a §3.2 y §4.6

La tabla de cambios de §0 dice `Account.isMonetary`; §3.2 (línea 731) y R-FX-2 dicen `LedgerAccount.isMonetary`. En `prisma/schema.prisma` conviven **`Account`** (heredado de TaxHacker) y **`LedgerAccount`** (el plan contable), y el atributo pertenece al segundo. Una errata en un nombre de modelo que existe es peor que una en uno que no existe: T-3 puede añadir la columna a la tabla equivocada.

**Corrección exacta.** Unificar en **`LedgerAccount.isMonetary`** en §0 y en la tabla de O-4 del ADR (D6.2 ya lo dice bien).

## 10. Autorización

Las treinta observaciones están cerradas y las tres residuales son correcciones de texto que no alteran ningún criterio contable ni ningún asiento. **No procede una tercera ronda.**

`T-2` incorpora R2-1, R2-2 y R2-3 y lleva **ADR-0016 (D1–D12) a firma humana**. Con la firma quedan desbloqueadas todas las tareas de Nivel 2 de E9; las marcadas **▶** en §13 del diseño pueden arrancar desde ya, con la única salvedad de que **T-3 debe escribir `LedgerAccount.isMonetary`** (R2-3) y **T-4 sembrar los veintitrés pares de R2-1**.

*Ronda 2 del agente `experto-contable`. No modifica el diseño ni el ADR.*
