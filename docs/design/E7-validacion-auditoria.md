# E7 — Validación contable de la pestaña de Auditoría y de la conciliación bancaria

> Rol: `experto-contable`. Validación de `docs/design/E7-auditoria.md` (ronda 1, PROPUESTA) y de
> `docs/adr/0015-auditoria-bigint-conciliacion-retencion.md` (PROPUESTO).
> Fuentes: `docs/spec/SPEC-FIABILIDAD.md` §C4–C7 y §1 (P1–P7) · `.claude/skills/fiabilidad/SKILL.md`
> (I1–I10, I-E8-*, badges de C5) · `.claude/skills/pgc-npgc/SKILL.md` · `docs/design/E6-validacion-estados.md`
> (R-B1…R-B6, las cuatro fotos del balance) · ADR-0003, ADR-0005, ADR-0006, ADR-0011, ADR-0012, ADR-0014.
> Norma: **RD 1514/2007** (PGC 2007, NRV 9ª y 11ª) · **Código de Comercio arts. 25–30** · **LIVA art. 20.Uno.18º**
> · **Cuaderno 43 AEB/CECA** (Norma 43, edición vigente) · **LIS art. 26.5** · **LGT arts. 66 y 68**.
> **Este documento no modifica el diseño ni el ADR.** Todas las cifras que aparecen son ilustrativas.

---

## 0. Veredicto

> ## OBSERVACIONES
>
> El marco es sólido y **no se pide rehacerlo**: determinismo sin LLM (P1/ADR-0005), sin auto‑punteo,
> empate ⇒ ninguna sugerencia, `SIN_EVALUAR` como estado propio, `coverage` obligatorio, sellos
> append‑only, diff con causa, y la negativa a crear `DataQualityIssue` como tabla (§2.6) y a rellenar
> `linesHash` por script (§2.5) son decisiones **contablemente correctas y bien argumentadas**.
>
> Pero la pieza contable central —**el cuadre de conciliación**— está mal formulada, y el modelo de datos
> no puede representar tres hechos bancarios ordinarios (remesas, comisiones sin asiento, cuentas en
> divisa). Tal como está, I‑E7‑1 no cuadraría nunca en una empresa real, el badge
> `✓ validado contra fuente` no se encendería jamás y, donde sí se encendiera, podría mentir.
>
> **10 observaciones bloqueantes** (B) — cuatro de ellas cambian el esquema de M3 y por tanto exigen una
> **D6 en ADR‑0015 antes de la firma**: O‑1, O‑3, O‑5, O‑9.
> **9 observaciones importantes** (I) y **6 de mejora** (M).

| Bloque | Veredicto | Observaciones |
|---|---|---|
| Identidad del cuadre bancario (I‑E7‑1) | **NO CONFORME** | O‑1, O‑2, O‑6 |
| Modelo de conciliación (1:1, divisa, ignorados) | **NO CONFORME** | O‑3, O‑4, O‑5, O‑7, O‑8 |
| Invariantes I‑E7‑1…10 (corrección y suficiencia) | **OBSERVACIONES** | O‑9, O‑10, O‑11, O‑12, O‑13 |
| Norma 43 (parseo y fidelidad al cuaderno) | **OBSERVACIONES** | O‑14, O‑15 |
| Semántica de `✓ validado contra fuente` (D2) | **OBSERVACIONES** | O‑16, O‑17 |
| Contenido de la pestaña para fiarse de un cierre | **OBSERVACIONES** | O‑18, O‑19, O‑20 |
| Forzar revisión y `ManualReviewFlag` | **CONFORME con matices** | O‑21 |
| Retención y archivado (D3) | **CONFORME con matices** | O‑22 |
| `bigint` en el diario (D1) | **CONFORME** | O‑23 (refuerzo del criterio 17) |
| D4 (`ReportType`) y D5 (RLS `users`) | **CONFORME** | — (no son materia contable; sin objeción) |

---

## 1. La identidad del cuadre bancario

### O‑1 · **(B, cambia el diseño)** La fórmula de I‑E7‑1 no es la conciliación bancaria

El diseño enuncia (§3.5):

> «`saldo contable de la 57x = Σ importes del extracto conciliados + saldo inicial del extracto`, y la
> diferencia con el `closingBalanceCents` declarado por el banco = Σ de los pendientes».

Dos errores encadenados:

1. La primera igualdad **sólo es cierta si el saldo inicial del extracto estaba íntegramente conciliado
   y no había ni una partida en libros pendiente antes del periodo** — supuesto que nada comprueba. En
   cualquier empresa con un cheque emitido en diciembre y cargado en enero, la igualdad falla el 1 de
   enero y el invariante sale FAIL sin que haya ningún error contable.
2. La segunda mezcla dos magnitudes: compara el **saldo declarado por el banco** con un saldo contable
   ya "corregido" por la primera igualdad, de modo que los pendientes entran dos veces.

**Derivación correcta.** Sea, a la fecha de corte `D` y para **una** cuenta:

- `B` = saldo contable de la 57x = `Σ (debitCents − creditCents)` (convención R‑B1 de E6);
- `E` = saldo del extracto a `D` (declarado por el banco);
- `Ue` = Σ con signo de las **líneas de extracto no conciliadas** hasta `D`;
- `Ub` = Σ con signo (`debe − haber`) de los **apuntes de la 57x no conciliados** hasta `D`.

Como cada conciliación viva empareja importes iguales y de signo coherente (O‑9), la suma de lo
conciliado se cancela y queda la identidad exacta:

> **`E − B = Ue − Ub`**, con **tolerancia 0**, y con `Ue` y `Ub` **enumerados uno a uno**.

Es la forma canónica del estado de conciliación bancaria y no necesita el saldo inicial del extracto
para nada: éste desaparece al ser `E` acumulado. Un descuadre que no se explique por las dos listas es
FAIL; y **la diferencia no es "explicada" por el mero hecho de listarla** (ver O‑17).

**Corrección concreta.** Sustituir el enunciado de I‑E7‑1 por la identidad `E − B = Ue − Ub`, con la
salida estructurada `{ saldoExtracto, saldoContable, diferencia, pendientesBanco[], pendientesLibros[] }`,
y añadir el **anclaje**: I‑E7‑1 sólo puede dar PASS si la cadena de extractos de la cuenta cubre desde el
`puntoDeArranque` de la cuenta (campo nuevo `reconciledFromDate` + `reconciledOpeningBalanceCents` en
`BankAccount`, fijado por un ADMIN al dar de alta la cuenta y no editable sin `AuditLog`) hasta `D`, sin
huecos. Sin anclaje, el invariante sale **INFO**, nunca PASS.

### O‑2 · **(B)** El saldo contable de la 57x no dice qué `kind` de asientos agrega

El diseño nunca fija qué asientos entran en `B`. E6 ya demostró (las cuatro fotos, §1.1 de
`E6-validacion-estados.md`) que esto no es un detalle: con `OPENING` excluido, el 2 de enero el saldo de
la 572 es 0 y toda la conciliación del ejercicio nuevo sale descuadrada por el saldo de arrastre; con
`CLOSING` incluido, el 31 de diciembre sale 0.

**Corrección concreta.** Escribir en §3.5: `B` agrega las líneas de la 57x de asientos con
`kind ∉ {CLOSING}` — es decir, **`OPENING` sí entra** y `REGULARIZATION` es irrelevante (no toca 57x, y
si la tocara sería un error que I‑E7‑1 debe delatar, no absorber). Es la foto `PRE_REGULARIZACION` de E6
restringida a la 57x; reutilizar esa misma función y no escribir una segunda.

### O‑6 · **(B)** Fecha valor vs fecha de operación: el corte tiene que ser por fecha de operación

El diseño indexa por `valueDate`, sugiere por `|valueDate − entryDate|` y no dice con qué fecha se corta
el cuadre. Contablemente la **fecha valor no existe**: es un dato financiero que sólo sirve para el
cálculo de intereses y descubiertos. El devengo del cobro/pago —y por tanto la pertenencia de un
movimiento al periodo— es la **fecha de operación** (fecha contable del banco). Cortar por fecha valor
mueve movimientos a través del cierre: un pago con operación 30/12 y valor 02/01 saldría del ejercicio.

**Corrección concreta.** (a) I‑E7‑1 corta **siempre** por `operationDate`; escribirlo como regla y
prohibir `valueDate` en cualquier agregación de cuadre. (b) La sugerencia mide `|operationDate −
entryDate|` como criterio principal y añade un motivo secundario `FECHA_VALOR` con puntuación menor
(`+500`) cuando lo que casa es la fecha valor: es información útil y no debe decidir. (c) Cambiar el
índice a `@@index([organizationId, bankAccountId, status, operationDate])`. (d) Declarar el mapeo N43
explícito: registro 22, `fecha de operación` posiciones 11‑16, `fecha valor` 17‑22 — invertirlas es un
error silencioso que ningún invariante detectaría.

---

## 2. Lo que el modelo 1:1 no puede representar

### O‑3 · **(B, cambia M3 · exige D6 en ADR‑0015)** Cargos agrupados y remesas: N‑a‑1 y 1‑a‑N

`BankReconciliation` con dos índices únicos parciales impone una conciliación estrictamente **1:1**. La
realidad ordinaria de una PYME de servicios no lo es:

| Hecho | Forma | Ejemplo (ilustrativo) |
|---|---|---|
| **Remesa de recibos al cobro** (norma 19) | **N‑a‑1** | 14 apuntes al debe de 572 (uno por recibo, `4300` al haber) contra **un** abono del banco de 8 420,00 € |
| **Remesa de pagos / confirming** (norma 34) | **N‑a‑1** | 9 apuntes al haber de 572 contra **un** cargo de 22 110,00 € |
| **Nómina pagada en un único cargo** | **N‑a‑1** | 12 apuntes a `465` liquidados con un cargo global |
| **Descuento de efectos** | **N‑a‑1 con tres cuentas** | Abono neto = nominal `4311` − intereses `665` − comisión `626` |
| **Devolución parcial de una remesa** | **1‑a‑N** | Un apunte de remesa contra el abono íntegro y el posterior cargo por el recibo devuelto |
| **Transferencia dividida por el banco** | **1‑a‑N** | Un pago contabilizado que el banco parte en principal y gastos SWIFT |

Con el modelo actual estos casos **no se pueden conciliar**. El usuario tiene dos salidas y las dos son
peores que el problema: dejar todo `UNMATCHED` (I‑E7‑1 en FAIL permanente y el badge P6 nunca se
enciende), o marcar `IGNORED` con motivo (el cuadre "cierra" mientras el saldo real está mal — el
anti‑patrón de la spec §5, «entregar un informe cuya validación falló, sin sello de advertencia»).

**Corrección concreta.** Introducir un **grupo de conciliación**:

```
BankMatchGroup { id, organizationId, bankAccountId, kind: SIMPLE|N_A_1|1_A_N|N_A_N,
                 note?, createdById, createdAt, unmatchedAt?, unmatchedById?, unmatchReason? }
```

`BankReconciliation` pasa a ser la **fila de pertenencia** (`groupId` obligatorio; un grupo `SIMPLE` tiene
una línea y un apunte, y todo el diseño actual sigue siendo el caso particular). Los dos índices únicos
parciales **se conservan tal cual** —una línea y un apunte siguen perteneciendo a lo sumo a un grupo
vivo—, y el desconciliar se hace a nivel de grupo, con el mismo motivo ≥ 10 caracteres. Se añade:

> **I‑E7‑11 · Cuadre del grupo.** Para todo grupo vivo,
> `Σ amountCents de sus líneas de extracto = Σ (debitCents − creditCents) de sus apuntes`,
> **tolerancia 0**. Un grupo con un solo elemento en cada lado es el caso 1:1 y también lo cumple.

Con I‑E7‑11, I‑E7‑1 sigue siendo exacta sin cambios: los grupos se cancelan igual que los pares.
Esto **cambia la migración M3** y por tanto es Nivel 2 → **D6 del ADR‑0015**, a firmar antes de T3.

### O‑4 · **(B)** Comisiones, intereses y gastos: un movimiento sin asiento no puede acabar en `IGNORED`

`IGNORED` está documentado como «comisión ya contabilizada en otro sitio, apunte del banco que no es
nuestro». Es la puerta por la que se escapa el rigor: una comisión de mantenimiento de 3,50 € que nadie
ha contabilizado **existe en el banco y no existe en los libros**; ignorarla no la concilia, la esconde,
y deja la 572 permanentemente corta en 3,50 € sin que ningún check lo diga.

**Corrección concreta.**

1. **Acotar `IGNORED` a lo que de verdad no es nuestro**, con **vocabulario cerrado** (no texto libre) y
   dato asociado, no prosa:
   `ERROR_BANCO_REVERSADO` (exige apuntar la línea de extracto que lo revierte),
   `NO_ES_NUESTRA_CUENTA`,
   `YA_CONTABILIZADO_EN_OTRA_CUENTA` (**exige el `journalLineId` concreto**, y entonces no es «ignorar»:
   es un dato auditable). Cualquier otro caso **no es ignorable**.
2. **Movimiento sin asiento ⇒ propuesta de asiento, nunca automática** (P1, ADR‑0005). Desde
   `/audit/bank/[id]`, la línea ofrece **Proponer asiento**, que precarga una propuesta y la manda por el
   **mismo** camino que el documental: `previewFromProposal` → confirmación humana → `postFromProposal`,
   con `AuditLog`, autor, y el asiento con `origin = CONCILIACION` y referencia a `statementLineId`.
   Nada se postea sin que una persona lo confirme, y el asiento resultante se concilia con la línea en la
   misma transacción.
3. **Las cuentas de la propuesta salen de configuración, nunca del código ni del texto del movimiento**:
   ampliar `OrganizationAccountMap` con `COMISIONES_BANCARIAS → 626`, `INTERESES_DEUDAS → 662`,
   `OTROS_GASTOS_FINANCIEROS → 669`, `INTERESES_DESCUENTO_EFECTOS → 665`,
   `DIFERENCIAS_NEGATIVAS_CAMBIO → 668`, `DIFERENCIAS_POSITIVAS_CAMBIO → 768`. Deducir la cuenta del
   texto del apunte es auto‑punteo por patrón: es **E12** y va con ADR.
4. **IVA de las comisiones — matiz que hay que escribir.** Los servicios financieros del art. 20.Uno.18º
   LIVA están **exentos**: la propuesta de una comisión de transferencia, de mantenimiento o de descubierto
   es `626 / 572` por el total, **sin cuota**. Pero la **gestión de cobro de efectos** (letra h del mismo
   artículo), el alquiler de cajas de seguridad y los servicios de custodia **sí están sujetos y no
   exentos**: esos llegan con factura y **deben entrar por el camino documental (E8), no desde el
   extracto**. La pantalla debe bloquear la propuesta y decirlo cuando el usuario elija una cuenta con
   IVA soportado asociado.

### O‑5 · **(B, cambia M3 · exige D6)** Cuentas en divisa: `currency` existe y no se usa para nada

`BankAccount.currency` está en el modelo; `BankStatementLine` no tiene divisa ni importe original,
mientras que `journal_lines` **ya lleva** `original_amount_cents` (I‑E8‑19 exige las tres columnas,
NRV 11ª.2.1). Consecuencias con el diseño actual:

- La regla 1 de `suggestMatches` («el importe tiene que coincidir al céntimo») es **inaplicable** en una
  cuenta en USD: el extracto viene en USD y el apunte de 573 está en EUR a la tasa del día. Ninguna
  sugerencia se produciría nunca.
- I‑E7‑1 en EUR es **imposible de cuadrar**: la diferencia entre `E` y `B` incluiría la variación de la
  tasa, que no es una partida en tránsito.
- Un extracto en USD importado sobre una cuenta declarada en EUR pasaría todos los checks.

**Corrección concreta.**

1. Añadir a `BankStatementLine`: `currency @db.VarChar(3)` (de la cabecera N43 registro 11 / del mapeo
   CSV) y `originalAmountCents BigInt?` (registro 24 de la Norma 43, que el propio diseño ya dice que
   parsea y no guarda en ninguna parte).
2. CHECK / validación de importación: `statement.currency = bankAccount.currency`; un extracto de otra
   divisa se rechaza entero con el motivo.
3. **El cuadre de una cuenta en divisa se hace en la divisa de la cuenta**: I‑E7‑1 compara
   `Σ amountCents` del extracto contra `Σ (originalAmount con signo)` de los apuntes de la 573/575,
   **tolerancia 0**. El emparejamiento y el signo (I‑E7‑4) también, en divisa.
4. Añadir el invariante que falta:

   > **I‑E7‑12 · Coherencia divisa/EUR de una cuenta en moneda extranjera.** El saldo en euros de la
   > cuenta = Σ de los contravalores históricos de sus apuntes; la diferencia entre ese importe y
   > `saldo en divisa × tasa de cierre` es la **diferencia de cambio** pendiente de reconocer
   > (NRV 11ª.2.2: las partidas monetarias se valoran al tipo de cierre, con la diferencia a `768`/`668`).
   > Se presenta como tal, **nunca como pendiente de conciliación**, y a fecha de cierre sin asiento de
   > `768`/`668` que la recoja, sale **WARN** con su importe.

   Escribir explícitamente la regla negativa: *una diferencia de cambio jamás aparece en `Ue` ni en `Ub`;
   si aparece, el cuadre se está haciendo en la divisa equivocada.*

### O‑7 · **(I)** Una `BankAccount` por subcuenta, y la 57x no puede ser cualquiera

El CHECK propuesto es «la cuenta empieza por `57`». Eso admite `570`/`571` (**caja**, que no tiene
extracto y no es conciliable jamás) y `576` (inversiones a corto plazo de gran liquidez, que tampoco lo
es). Y nada impide **dos** `BankAccount` apuntando a la misma subcuenta, en cuyo caso `B` se computa dos
veces y I‑E7‑1 descuadra por diseño.

**Corrección concreta.** (a) Restringir el CHECK a `572`, `573`, `574`, `575` (cuentas corrientes y de
ahorro, en euros y en moneda extranjera) y excluir explícitamente `570`, `571`, `576`; una tarjeta de
crédito se modela como subcuenta de `572` o como `5205`, y en este último caso queda fuera de E7 y hay
que decirlo. (b) Añadir `@@unique([organizationId, accountCode])` en `BankAccount`. (c) Documentar la
regla PGC: **cada cuenta corriente es su propia subcuenta de 572** (`5720001`, `5720002`…); conciliar dos
bancos contra una 572 agregada es imposible de cuadrar y el modelo debe impedirlo, no advertirlo.

### O‑8 · **(I)** Cheques, efectos y partidas en tránsito: hay que tiparlas y envejecerlas

Los pendientes de I‑E7‑1 no son homogéneos y un CFO no los lee como una lista plana. Un cheque emitido
hace ocho meses y no cargado no es una partida en tránsito: es un asiento erróneo, un cheque perdido o un
pago que nunca ocurrió — y es **exactamente lo que se busca en un cierre**.

**Corrección concreta.** Tipar cada pendiente y envejecerlo:

| Tipo | Lado | Tratamiento |
|---|---|---|
| `CHEQUE_EMITIDO_NO_CARGADO` | libros | normal hasta el plazo de presentación; WARN pasado el umbral |
| `REMESA_NO_ABONADA` | libros | normal dentro de los días de abono pactados |
| `EFECTO_EN_GESTION_DE_COBRO` | ninguno | **no conciliable**: vive en `4312`/`4311`, no en 57x. Excluir |
| `TRASPASO_ENTRE_CUENTAS_EN_CAMINO` | ambos | debe casar con el pendiente espejo de la otra cuenta |
| `MOVIMIENTO_BANCO_SIN_ASIENTO` | banco | va a propuesta de asiento (O‑4) |
| `APUNTE_SIN_MOVIMIENTO` | libros | sospechoso por definición pasado el umbral |

Y añadir el motivo de sello `PARTIDA_EN_TRANSITO_ANTIGUA` (kind `AVISO`) para todo pendiente con
antigüedad > umbral configurable por organización (**sugerido 90 días**, parametrizable, nunca constante
en el código). Escribir además que el **descuento de efectos** (`4311`/`5208`/`665`) y los efectos en
gestión de cobro (`4312`) entran por el camino documental y **no** son conciliables contra el extracto:
lo único conciliable es el abono neto que el banco practica.

---

## 3. Los invariantes I‑E7‑1…10: ¿correctos, tolerancia 0, suficientes?

**Tolerancia.** Correcta y no negociable: **0 en todo lo que compara importes**. No aplica aquí la
tolerancia de 1 céntimo del reparto por mayor resto (I5), porque en conciliación no hay reparto: hay
igualdad o no la hay. La tolerancia de 0,01 que la spec §C4 admite para «las partes suman el total» es un
mínimo de la spec genérica; el ERP ya la endurece a 0 y así debe quedar.

### O‑9 · **(B)** I‑E7‑2 no compara importes — y I‑E7‑4 sólo mira el signo

Tal como están escritos, un punteo manual de una línea de **100,00 €** contra un apunte de **1 000,00 €**
pasa I‑E7‑2 (misma org, cuenta 57x, misma cuenta, fecha en tolerancia) y pasa I‑E7‑4 (signos
coherentes). El error sólo aflora como una diferencia sin nombre en I‑E7‑1. El motor de sugerencia sí
exige importe exacto, pero **el camino de escritura manual no**, y es justo el que usa una persona con
prisa en un cierre.

**Corrección concreta.** Fundir las dos condiciones en un único invariante fuerte, verificado también en
el camino de escritura (`matchAction`) y no sólo en el barrido:

> **I‑E7‑2 (revisado).** Para toda conciliación viva: misma organización · cuenta de la `JournalLine`
> ∈ {572,573,574,575} e **igual** a la de la `BankAccount` · y
> **`bankLine.amountCents = journalLine.debitCents − journalLine.creditCents`** (con signo, al céntimo,
> en la divisa de la cuenta). **Tolerancia 0.** I‑E7‑4 queda subsumido y se conserva sólo como evidencia
> legible del signo. En grupo (O‑3), la igualdad es la de I‑E7‑11.

### O‑10 · **(B)** La tolerancia de fechas no puede ser un invariante

I‑E7‑2 exige `|valueDate − entryDate| ≤ toleranceDays` **de la cuenta**. Dos defectos graves:

1. Un punteo legítimo con más desfase (una transferencia atascada en Navidad, un cheque de 40 días) deja
   el barrido en FAIL **para siempre**, sin que exista error contable alguno.
2. `matchToleranceDays` es **configuración editable**. Si alguien la baja de 5 a 2, **cambian los checks
   de runs ya sellados**: dos barridos sobre el mismo `ledgerHash` y el mismo `gitSha` darían resultados
   distintos. Eso rompe P7 y el propio `diffRuns`, que concluiría `cause: "NINGUNA"` con deltas — caso que
   el criterio de aceptación 4 declara imposible.

**Corrección concreta.** (a) Sacar la condición de fechas de I‑E7‑2. (b) Persistir `dateGapDays` en
`BankReconciliation` **en el momento del punteo** (dato del hecho, inmune a cambios posteriores de
configuración) y exponerlo como métrica `DESFASE_FECHA_ALTO` (WARN por encima del umbral), nunca FAIL.
(c) Incluir un `configHash` en `InvariantRun` y en su clave de caché (ver O‑20), para que ninguna
configuración fuera del sello pueda mover un check.

### O‑11 · **(I)** I‑E7‑6 es tautológico en el caso que importa

«El `closingBalance` de un extracto = `openingBalance` del siguiente **cuando los periodos son
contiguos**» no dice nada cuando no lo son, que es justo el caso peligroso: **un hueco en la cadena de
extractos**. Con un hueco, I‑E7‑1 puede dar PASS sobre un periodo del que no se tiene fuente.

**Corrección concreta.** Partir el invariante: (a) **I‑E7‑6a** — cuadre interno
`opening + Σ amountCents = closing` (tolerancia 0; INFO si el banco no declara saldos); (b) **I‑E7‑6b** —
**cobertura de la cadena**: para el periodo auditado y cada cuenta, la unión de los periodos de extracto
cubre `[inicio, corte]` sin huecos y sin solapes contradictorios; un hueco es **FAIL**, y mientras exista,
I‑E7‑1 sale **INFO**, jamás PASS. Añadir además el cotejo contra el **registro 33** de la Norma 43 (final
de cuenta), que declara número de apuntes y saldo final: comparar contra lo declarado por el banco, no
sólo contra la aritmética propia.

### O‑12 · **(I)** Nada vigila el vertedero de `IGNORED`

No hay ningún check sobre las líneas ignoradas. Es donde se acumula la basura y es donde primero mira un
auditor.

**Corrección concreta.** Añadir:

> **I‑E7‑13 · Ignorados acotados.** Toda línea `IGNORED` tiene motivo del vocabulario cerrado (O‑4) y, si
> el motivo es `YA_CONTABILIZADO_EN_OTRA_CUENTA` o `ERROR_BANCO_REVERSADO`, el `journalLineId` o la
> `statementLineId` que lo respalda. El cuadre presenta `Σ importes ignorados` del periodo **como una
> línea propia y visible**, y una organización cuyo Σ ignorado supere el umbral de materialidad de la
> cuenta sale **WARN** con la lista.

### O‑13 · **(M)** Conciliar un ejercicio cerrado debe ser posible y no debe tocar nada

La conciliación se practica normalmente **después** del cierre. El diseño no dice qué pasa. Como
conciliar es un hecho de gobierno que **no escribe en el diario**, debe permitirse sobre un ejercicio
`CLOSED`.

**Corrección concreta.** Escribirlo como regla explícita y añadir el check de que `matchAction` /
`unmatchAction` **no modifican ni una `journal_line`** (el `ledgerHash` del periodo es idéntico antes y
después). En cambio, la **propuesta de asiento** de O‑4 sí escribe, y por tanto queda sujeta a I8: si la
fecha cae en un ejercicio no `OPEN`, se bloquea con mensaje (o se postea con fecha de la reapertura, que
es decisión del ADMIN, no del motor).

---

## 4. Norma 43

### O‑14 · **(I)** El signo y el año de dos dígitos son dos errores silenciosos esperando

El diseño dice «importes en céntimos y el signo en el campo de debe/haber». Correcto, pero incompleto en
lo único que importa: **qué valor es qué**. En el cuaderno 43, registro 22, el indicador vale `1` = debe
(**cargo**: disminuye el saldo del titular ⇒ `amountCents < 0`) y `2` = haber (**abono** ⇒
`amountCents > 0`). Invertirlo produce un extracto que cuadra consigo mismo (I‑E7‑6a pasa: los signos
invertidos siguen sumando al saldo invertido sólo si también se invierten los saldos — y si no, falla por
el doble del importe, ilegible) y que I‑E7‑4 **confirmaría** como coherente en cada punteo. Además las
fechas son `AAMMDD`: sin ventana de siglo fijada, un extracto archivado de 1998 se parsea como 2098.

**Corrección concreta.** (a) Escribir la tabla de signos en el diseño y añadir al fixture de T7 **un cargo
y un abono** con aserción explícita de signo, más un caso de saldo final negativo (descubierto). (b) Fijar
la ventana de siglo (`00–79 → 20xx`, `80–99 → 19xx`) como constante documentada. (c) El importe son 14
dígitos sin signo: comprobar el desbordamiento contra `bigint` al parsear y rechazar el fichero, nunca
truncar.

### O‑15 · **(I)** Una sola `reference` colapsa las dos referencias del cuaderno, que es justo la clave de la remesa

El registro 22 lleva **referencia 1** (12 posiciones) y **referencia 2** (16), más **concepto común** (2
dígitos) y **concepto propio** (3). El diseño guarda un único `reference String? @db.VarChar(140)`. La
referencia 1 es la que identifica la **remesa**, y sin ella el emparejamiento N‑a‑1 de O‑3 no tiene
ninguna clave determinista con la que agrupar: quedaría a merced del texto libre.

**Corrección concreta.** Guardar `reference1`, `reference2`, `conceptCommon`, `conceptOwn` por separado
(y el registro 23 de conceptos complementarios concatenado en `description`, como ya se hace). Usar
`reference1` como criterio de agrupación propuesto para grupos N‑a‑1 (`+2500`, mismo trato determinista
que el resto: contención exacta tras normalizar, nunca similitud). En CSV, el mapeo por banco declara qué
columna es cada cosa; si no hay, `null`, y entonces la agrupación por referencia simplemente no se ofrece.

---

## 5. `✓ validado contra fuente` (ADR‑0015 D2)

La decisión de anclar el badge en la conciliación es **correcta y bien acotada** (no se contagia a PyG ni
a balance, se retira solo). Dos precisiones necesarias para que no mienta.

### O‑16 · **(B)** La tesorería del balance incluye caja, que no tiene fuente externa

El epígrafe `B.VII.1 Tesorería` del balance agrega **todas** las 57x, caja incluida (en el fixture de E6:
`572` 2 913 920 + `570` 30 000 = 2 943 920, cifra ilustrativa). La caja **nunca** puede conciliarse contra
un extracto. Con la regla escrita «para la cuenta 57x de la que se deriva», una cifra agregada podría
recibir el badge por conciliar sólo su componente bancaria.

**Corrección concreta.** Redactar la regla **por composición**: una cifra lleva
`✓ validado contra fuente` si y sólo si **todas** las cuentas que la componen están íntegramente
conciliadas para el periodo. Consecuencia explícita y honesta, que hay que escribir en el ADR: *una
organización con caja no verá nunca el badge en la tesorería total del balance; lo verá en el detalle por
cuenta bancaria y en el cashflow si su cashflow no incluye caja.* Un arqueo de caja firmado **no** es
fuente equivalente en E7 (podría serlo en E12, con ADR).

### O‑17 · **(B)** «Ni un pendiente sin explicar» no está definido — y así se concede por enumeración

Tal como está, listar un pendiente lo "explica". Es exactamente el anti‑patrón que la spec §5 prohíbe.

**Corrección concreta.** Definir `explicado` con criterio verificable, no editorial:

| Un pendiente está **explicado** si… |
|---|
| es del lado **banco** y existe ya un asiento posterior conciliado que lo recoge; **o** |
| es del lado **libros** y existe ya una línea de extracto posterior conciliada que lo recoge; **o** |
| está **tipado** (O‑8) y su antigüedad es **menor** que el umbral de tránsito de la organización |

Cualquier otro pendiente es `sin explicar` y **retira el badge**. Añadir además: (a) el badge exige
I‑E7‑6b en PASS —cobertura de la cadena sin huecos— y no sólo I‑E7‑1; (b) el badge **se deriva en lectura
y no se persiste nunca**, porque un extracto importado en febrero puede contener un movimiento con fecha
de operación de diciembre y debe **retirar** un badge ya concedido sobre diciembre; añadir ese caso como
criterio de aceptación al 15.

---

## 6. Qué debe ver la pestaña para que un CFO se fíe de un cierre

Lo que hay (familias con semáforo, `coverage`, evidencia literal, drill‑down en 3 clics, calidad de datos
con acción, `AuditLog` paginado, historial con diff y causa, export de `validacion.json`, prueba de
detección no destructiva) es **la arquitectura correcta**. Faltan piezas que un cierre exige.

### O‑18 · **(I)** Faltan los cuadres clásicos de cierre como checks de primera clase

| Falta | Qué debe mostrar | Norma / referencia |
|---|---|---|
| **Balance de sumas y saldos** | Σdebe = Σhaber del periodo **y por mes**, con los cuatro totales del balance de comprobación | art. 28.1 CCom (trimestral, obligatorio) |
| **Continuidad entre ejercicios** | saldo de apertura de N, cuenta a cuenta, = saldo de cierre de N−1 (las fotos `POST_REGULARIZACION` y `APERTURA_2027` de E6 lo prueban en el fixture, pero **no hay check que lo verifique en datos reales**) | art. 25 CCom; R‑B5 de E6 |
| **Saldos contrarios a su naturaleza** | `430` acreedor, `400`/`410` deudor, `572` acreedor sin póliza de crédito, `473` acreedor. E6 ya lo hace para `472`/`477` (R‑B6): **generalizar** | anomalía de cierre |
| **Cuentas puente con saldo** | `555` (partidas pendientes de aplicación) con **cualquier** saldo a fecha de cierre; `551`; `4749` | `555` con saldo al cierre es un hallazgo, no un aviso |
| **Antigüedad de saldos** | aging de `430`/`400`/`410` y de los pendientes de conciliación | deterioro (NRV 9ª) y O‑8 |
| **Puentes fiscales con el modelo** | I‑E8‑15a/b/c e I‑E8‑17 mostrados **con el modelo (303/111/115) y el periodo**, no sólo con el id del check | — |

**Corrección concreta.** Añadirlos a las familias existentes (`ESTADOS` los tres primeros, `DOCUMENTAL` el
último) y pintarlos como líneas nombradas en la pestaña. **No** hace falta inventar invariantes nuevos si
ya existen: hace falta que la pestaña los **nombre en lenguaje de cierre**, que es lo que permite fiarse.

### O‑19 · **(I)** El diff entre runs compara checks; un CFO compara cifras

`diffRuns` devuelve deltas de estado de check y la causa. Es necesario y no basta: lo que se mira al
comparar dos barridos de un cierre es **qué se movió**.

**Corrección concreta.** Añadir al diff los `Δ` de cuatro totales derivados de los dos estados
(`TOTAL ACTIVO`, `PN + PASIVO`, `RESULTADO DEL EJERCICIO` (I3) y `TESORERÍA` (Σ57x)), calculados por SQL
sobre cada `ledgerHash`, con su provenance. Es barato, es derivado (no viola ADR‑0003) y convierte el
diff en algo legible por quien firma.

### O‑20 · **(I)** La clave de caché del barrido no incluye la configuración que lo condiciona

§8 reutiliza un `InvariantRun` con la misma
`(scope, ledgerHash, analyticsKey, planHash, accountMapHash, gitSha, refDate)`. Pero `coverage` depende de
`MAX_MATERIALIZED_ENTRIES`, y varios checks dependen de umbrales, de `matchToleranceDays` y de los
`ManualReviewFlag` vivos — **nada de eso está en la clave**. Se serviría un barrido obsoleto tras cambiar
un umbral, que es justo cuando hay que rebarrer.

**Corrección concreta.** Añadir `configHash` (sha256 de la forma canónica de: umbrales de revisión,
`MAX_MATERIALIZED_ENTRIES`, `matchToleranceDays` por cuenta, umbral de tránsito, variante del plan) como
columna de `InvariantRun`, como quinto hash de la pantalla y como parte de la clave de caché y del diff
(`cause` gana el valor `CONFIGURACION`).

---

## 7. Forzar revisión, retención y `bigint`

### O‑21 · **(M)** `ManualReviewFlag`: acertado reutilizarla; dos detalles

Reutilizar `ManualReviewFlag` en vez de crear `ReviewRequest` (§2.7) es **correcto**: dos mecanismos de
«forzar revisión» darían dos sellos posibles para el mismo periodo. Dos matices:

**Corrección concreta.** (a) `checkFamily String? @db.VarChar(24)` debe ser el **enum `CheckFamily`** (o
CHECK contra los siete valores): con texto libre, una errata acota la revisión a nada y el periodo queda
sellado como si se hubiera revisado. (b) Escribir explícitamente que **forzar revisión sobre un ejercicio
`CLOSED` es posible** — descubrir un error después del cierre es precisamente cuando se fuerza — y que
levantarla exige motivo y ADMIN, como ya está.

### O‑22 · **(M)** Retención: correcta; añadir la conservación mercantil de los extractos

D3 es sensata y más exigente que C1 (24 meses + mensual + todo ejercicio `CLOSED`, que no se purga nunca).
Falta la norma que manda sobre los **extractos**: el art. 30 CCom obliga a conservar libros,
correspondencia, documentación y justificantes **seis años**; los soportes de la conciliación son
justificantes. Las bases imponibles negativas alargan la comprobación a diez años (art. 26.5 LIS).

**Corrección concreta.** Escribir en D3: (a) `BankStatement`, `BankStatementLine` y **el `File` original
del extracto** no se purgan y su archivado en frío (E9) debe garantizar **legibilidad a seis años**;
(b) `prune-runs.ts` nunca borra un `File` referenciado por un `BankStatement` — añadir la comprobación al
script y un test; (c) mencionar que la política de `InvariantRun` es de auditoría interna y no sustituye
la conservación mercantil.

### O‑23 · **(M)** `bigint`: ninguna cifra cambia — pero el riesgo está en el borde de JS, no en el DDL

**Confirmado desde lo contable**: `ALTER COLUMN … TYPE bigint` en PostgreSQL **preserva el valor** exacto
de todo `integer`; no hay redondeo, no hay reescalado y no hay cambio de representación decimal. Por tanto
`canonicalEntryForm`, `entryHash`, `ledgerHash`, `estados-esperados.json` y `pyg-analitica-esperada.json`
**no pueden moverse** — y con I1/I2/I3/I6 a tolerancia 0, cualquier desviación saltaría de inmediato.

El riesgo real es de tipos en el borde, y el criterio 17 no lo cubre entero: Prisma devuelve `BigInt`,
`JSON.stringify(BigInt)` **lanza**, y el arreglo apresurado —serializar como cadena `"1234"`— **sí
cambiaría el hash** sin cambiar una sola cifra.

**Corrección concreta.** Ampliar el criterio 17 con tres aserciones: (a) `canonicalEntryForm` recibe
`number`, nunca `BigInt` ni `string` (test de tipo + test de que el JSON canónico de un asiento es byte a
byte el mismo antes y después de M4); (b) el borde de `models/ledger.ts` comprueba
`Number.isSafeInteger` y **lanza** por encima de 2^53 − 1 en vez de perder precisión en silencio;
(c) los `SUM()` sobre `bigint` devuelven `numeric` en PostgreSQL — conservar los `::bigint` existentes y
añadir un test con una línea de 25 000 000,00 € (por encima del techo de `integer`, cifra ilustrativa) que
recorre postear → agregar → hash → informe.

---

## 8. Resumen de correcciones que cambian el esquema (y exigen D6 en ADR‑0015)

| Obs. | Cambio de esquema | Migración afectada |
|---|---|---|
| **O‑3** | `BankMatchGroup` + `groupId` en `BankReconciliation`; desconciliar por grupo | **M3** |
| **O‑5** | `currency`, `originalAmountCents` en `BankStatementLine`; CHECK de divisa del extracto | **M3** |
| **O‑1** | `reconciledFromDate`, `reconciledOpeningBalanceCents` en `BankAccount` | **M3** |
| **O‑7** | CHECK 572/573/574/575; `@@unique([organizationId, accountCode])` | **M3** |
| **O‑9/O‑10** | `dateGapDays` en `BankReconciliation` | **M3** |
| **O‑15** | `reference1`, `reference2`, `conceptCommon`, `conceptOwn` | **M3** |
| **O‑20** | `configHash` en `InvariantRun` | **M2** |
| **O‑21** | `checkFamily` como enum | **M2** |

Todas caen en M2/M3, que hoy son aditivas puras y **no dependen de la firma de ADR‑0015**. Si se
incorporan antes de T3, el coste es de diseño, no de migración correctiva. Si se dejan para después,
serán una segunda migración sobre tablas ya pobladas con datos bancarios — que es exactamente la deuda
que el §Estándar de calidad de `CLAUDE.md` prohíbe acumular.

**Invariantes nuevos propuestos:** I‑E7‑11 (cuadre de grupo), I‑E7‑12 (divisa y diferencia de cambio),
I‑E7‑13 (ignorados acotados); I‑E7‑2 revisado (importe con signo), I‑E7‑6 partido en 6a/6b.
**Motivos de sello nuevos:** `PARTIDA_EN_TRANSITO_ANTIGUA` (AVISO), `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER`
(AVISO), además de los dos ya propuestos.

---

## 9. Lo que está bien y no debe tocarse

1. **Sin LLM en ninguna parte de la conciliación** (P1, ADR‑0005), y el rechazo explícito de la similitud
   textual con umbral. Correcto y no negociable.
2. **Empate ⇒ ninguna sugerencia.** Es la decisión más acertada del documento: el desempate automático es
   donde se cuela el error silencioso.
3. **Nunca se puntea solo**, `acceptSuggestionsAction` exige ids explícitos, y cada conciliación guarda
   autor, método y puntuación. Añadir sólo que al aceptar se **recompute la sugerencia en servidor** y se
   dé error legible si el candidato ya fue conciliado por otro usuario entre el render y la aceptación.
4. **`SIN_EVALUAR` como estado propio** y `coverage` obligatorio. Un PASS no comprobado no existe: es la
   diferencia entre una pestaña de auditoría y un adorno.
5. **`DataQualityIssue` no es tabla** (§2.6) y **los `linesHash` que faltan no se rellenan por script**
   (§2.5). Las dos negativas son contablemente correctas y están bien argumentadas.
6. **Conciliar contra la `JournalLine` de 57x y no contra el asiento.** Correcto: un traspaso entre bancos
   mueve dos cuentas.
7. **La prueba de detección no escribe en el diario.** Correcto; la variante destructiva pertenece a los
   tests.
8. **D4 y D5** no tienen materia contable y no se objetan: la unificación de `CASHFLOW` con `method` en
   `params` es coherente con ADR‑0012, y el recálculo del `paramsHash` con la **misma** función de la
   aplicación evita la deriva que ADR‑0011 cerró.

---

*Documento de validación. No modifica `docs/design/E7-auditoria.md` ni `docs/adr/0015-*`; las correcciones
las incorpora el `arquitecto` en la ronda 2, y las que cambian esquema, en una **D6** de ADR‑0015 antes de
la firma.*

---

# Ronda 2 — verificación observación por observación

> Verificado contra `docs/design/E7-auditoria.md` (1329 líneas, Ronda 2) y
> `docs/adr/0015-auditoria-bigint-conciliacion-retencion.md` (320 líneas, Ronda 2, PROPUESTO con **D6**).
> Cada fila se ha cotejado con el texto real, no con la tabla-índice de §0 del diseño.

## R2.1 Estado de las 25 observaciones

| Obs. | Estado | Evidencia en el texto verificada |
|---|---|---|
| **O-1** | **CERRADA** | §3.5 enuncia `I-E7-1 · E − B = Ue − Ub`, tol. 0, pendientes enumerados y tipados, salida estructurada con `ignoradosCents`; `reconciledFromDate`/`reconciledOpeningBalanceCents` en `BankAccount` (§2.2); sin anclaje o sin I-E7-6b ⇒ **INFO, nunca PASS**. Criterios 9 y 10 |
| **O-2** | **CERRADA** | `B` = `kind ∉ {CLOSING}`, **`OPENING` sí entra**, y §3.7 obliga a reutilizar la función de la foto `PRE_REGULARIZACION`, no a escribir una segunda. Criterio 11 |
| **O-3** | **CERRADA** | `BankMatchGroup` (SIMPLE/N_A_1/1_A_N/N_A_N) + `groupId`; únicos parciales `WHERE group.unmatched_at IS NULL`; **I-E7-11** con tol. 0; desconciliar por grupo; **ADR D6.1**. Criterio 12 |
| **O-4** | **CERRADA** | §4.4 con el flujo `Proponer asiento → previewFromProposal → confirmación humana → postFromProposal`, `SourceType.BANK_RECONCILIATION`, conciliación en la misma transacción; `IgnoreReason` como enum de tres valores con evidencia obligatoria en dos; matiz IVA art. 20.Uno.18º con bloqueo en pantalla; **T23**. Criterio 15 |
| **O-5** | **CERRADA** | `currency`, `originalCurrency`, `originalAmountCents` en la línea; trigger `statement.currency = bank_account.currency`; cuadre en divisa; **I-E7-12** con la regla negativa literal; **D6.2**. Criterio 20 |
| **O-6** | **CERRADA** | Corte por `operationDate`; `valueDate` fuera de toda agregación de cuadre y sólo `+500` en la sugerencia; índice cambiado; mapeo N43 pos. 11-16 / 17-22; **D6.6**. Criterio 22 |
| **O-7** | **CERRADA** | CHECK cuenta ∈ {572,573,574,575} o subcuenta; `@@unique([organizationId, accountCode])` |
| **O-8** | **CERRADA** | Seis tipos de pendiente con tratamiento, `transitWarnDays` (default 90, configurable), motivo `PARTIDA_EN_TRANSITO_ANTIGUA`, y `4311`/`4312` **excluidos del cuadre** con el descuento de efectos descrito como grupo N-a-1 |
| **O-9** | **CERRADA** | I-E7-2 revisado a `bankLine.amountCents = debitCents − creditCents` con signo y divisa, tol. 0, revalidado en `matchAction`; I-E7-4 subsumido y conservado como evidencia. **D6.4**. Criterio 13 |
| **O-10** | **CERRADA** | Fechas fuera del invariante; `dateGapDays` **sellado en el punteo**; métrica `DESFASE_FECHA_ALTO`. Criterio 23 |
| **O-11** | **CERRADA** | I-E7-6a (interno + `lineCount` del registro 33) e I-E7-6b (cobertura, hueco = FAIL, e I-E7-1 en INFO mientras exista) |
| **O-12** | **CERRADA** | **I-E7-13**; Σ ignorado como línea propia del cuadre; WARN por materialidad. Criterio 16 |
| **O-13** | **CERRADA** | §4.3 permite conciliar sobre `CLOSED`; test de `ledgerHash` intacto en T11; la propuesta de asiento sigue sujeta a I8. Criterio 14 |
| **O-14** | **CERRADA** | Tabla de signos `1`=cargo/`2`=abono, ventana de siglo `00-79 → 20xx`, desbordamiento a `bigint` con rechazo del fichero; fixture con cargo, abono y descubierto. Criterio 21 |
| **O-15** | **CERRADA** | `reference1`/`reference2`/`conceptCommon`/`conceptOwn` separados y en la forma canónica del `sha256`; `reference1` como clave de agrupación N-a-1, y sin ella la agrupación **no se ofrece** |
| **O-16** | **CERRADA** | Badge **por composición** en §3.6 y en **D2**, con la consecuencia de la caja escrita literalmente y el arqueo excluido |
| **O-17** | **CERRADA** | Tabla de tres criterios verificables de `explicado`; badge condicionado también a I-E7-6b; **derivado en lectura, nunca persistido**, con la retirada retroactiva en el criterio 19 |
| **O-18** | **CERRADA** | **I-E7-14** (continuidad, art. 25 CCom), **I-E7-15** (saldos contrarios, generaliza R-B6), **I-E7-16** (`555`/`551`/`4749`, FAIL al cierre), **I-E7-17** (sumas y saldos mes a mes, art. 28.1 CCom); vista `/audit` §**Cuadres de cierre** en lenguaje contable, con los puentes fiscales nombrados «303 · 2026-Q4». Criterio 25 |
| **O-19** | **CERRADA** | `CifraDelta` con `fromCents/toCents/deltaCents/provenance` para activo, PN+pasivo, resultado y tesorería, en `/audit/runs/diff`. Criterio 4 |
| **O-20** | **CERRADA** | `configHash` como columna, quinto hash de la pantalla, parte de la clave de caché y `cause: CONFIGURACION` (+`VARIOS`). Criterio 23 |
| **O-21** | **CERRADA** | `checkFamily` es el enum `CheckFamily` en Prisma y en M2; forzar revisión sobre `CLOSED` explícito en §2.7 y en la matriz de acciones |
| **O-22** | **CERRADA** | D3 con art. 30 CCom (6 años), art. 26.5 LIS (10), legibilidad del archivado en frío y la prohibición de que `prune-runs.ts` borre un `File` referenciado por un extracto |
| **O-23** | **CERRADA** | D1 con las tres aserciones: `canonicalEntryForm` recibe `number`; el borde comprueba `Number.isSafeInteger` y **lanza**; se conservan los `::bigint`. Criterio 24 |
| **§9.3** | **CERRADA** | `acceptSuggestionsAction` recomputa en servidor y da error legible si otro usuario conció el candidato entre el render y la aceptación |

**25 de 25 CERRADAS. Ninguna ABIERTA.** Nada de lo que la ronda 1 declaró correcto se ha degradado:
sigue sin LLM, sin auto-punteo, con empate ⇒ sin sugerencia, `SIN_EVALUAR` con `coverage` obligatorio,
`DataQualityIssue` sin tabla, `linesHash` sin rellenar por script, conciliación contra la `JournalLine`
de 57x y prueba de detección que no escribe. Las siete familias cubren ahora los diecisiete I-E7-* sin
huérfanos (`ESTADOS` ← 14-17, `LIQUIDACION` ← 9-10, `DOCUMENTAL` ← 8, `CONCILIACION` ← 1,2,3,5,6a,6b,11,12,13,
`INTEGRIDAD` ← 7), y `unknownIds` sigue cubriendo el resto.

## R2.2 Veredicto final

> ## CONFORME CON OBSERVACIONES (menores)
>
> La identidad del cuadre es ahora la correcta, el modelo representa remesas, divisa, comisiones y
> anclaje, los invariantes de importe tienen tolerancia 0 y los de fecha han dejado de serlo, el badge
> no puede concederse por enumeración y los cuatro cuadres de cierre existen. **D6 es correcta y
> firmable**; el diseño puede pasar a implementación en cuanto ADR-0015 esté firmado.
>
> Quedan **dos correcciones menores de redacción/CHECK** que se aplican sin nueva ronda de validación:

| # | Dónde | Corrección exacta |
|---|---|---|
| **m1** | §2.2, párrafo «**Seis `AccountKey` nuevas (O-4)**», y la fila O-4 de §0 | El propio párrafo aclara que tres ya existen y sólo tres son nuevas — coherente con M1, M2, T2, T3 y T23, que dicen «tres». Sustituir el título por «**Seis `AccountKey` en juego, tres nuevas (O-4)**» y, en §0, «seis `AccountKey`» por «tres `AccountKey` nuevas». Es sólo el rótulo: el contenido ya es correcto |
| **m2** | M3, CHECK `amount_cents <> 0` | Algunos bancos emiten apuntes informativos de **0,00 €**; con este CHECK y la regla «un registro que no cuadre rechaza el fichero entero», un extracto legítimo sería inimportable. Relajar a `amount_cents IS NOT NULL` y que el parser marque la línea `IGNORED` con `ignore_reason = NO_ES_NUESTRA_CUENTA` y evidencia `IMPORTE_CERO`; un importe 0 no altera `Ue`, `Ub` ni I-E7-6a, así que el cuadre no se ve afectado |

*Ronda 2 cerrada. No procede una tercera.*
