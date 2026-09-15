---
name: fiabilidad
description: Capa de fiabilidad determinista (SPEC-FIABILIDAD v1.0 aplicada al ERP). Úsala siempre que una tarea produzca, transforme o muestre cifras - motor contable, informes, OCR/LLM, imputaciones, migraciones de datos, dashboards, exportaciones - o cuando haya que decidir qué puede afirmar un agente como hecho y qué requiere revisión humana.
---

# Fiabilidad en MICRO ERP SAAS

Spec completa: `docs/spec/SPEC-FIABILIDAD.md` (prevalece sobre cualquier prompt). Aquí: cómo se traduce al ERP.

## Traducción de principios al producto

| Principio | En el ERP significa |
|---|---|
| P1 código calcula | El LLM solo produce una **propuesta de extracción** (`ExtractionRun.proposal` JSON). El asiento lo construye `lib/ledger/postFromProposal()` tras `reconcile()` (Σitems = total, base + IVA = total, cuentas existen en el plan). Informes = SQL/funciones puras sobre `JournalLine`. |
| P2 SoT única | `JournalEntry`/`JournalLine` es la ÚNICA fuente de cifras contables. `Transaction` (heredado de TaxHacker) pasa a ser "documento/operación" y nunca fuente de informes. Tasas de cambio en tabla `ExchangeRate` (global, append-only, fuente BCE vía Frankfurter) con la tasa **de la fecha del documento**, no la de hoy: sin tasa publicada no se convierte (**RC-14**), no se inventa y no se guarda nada a medias. |
| P3 snapshot | Un informe se genera para `(organizationId, periodo, ledgerHash)` donde `ledgerHash = sha256` ordenado de las líneas del periodo. El resultado se persiste en `ReportRun` con ese hash; si el diario cambia, el hash cambia y el informe anterior queda como histórico, nunca sobrescrito. |
| P4 memoria ≠ cifras | `File.cachedParseResult` **eliminada de la base en E8**; lo histórico migró a runs `IMPORTED`, que `postFromProposal` rechaza (I-E8-1). Los agentes de desarrollo no "recuerdan" saldos: los recalculan. |
| P5 segregación | Extractor (LLM) ≠ validador (`reconcile`) ≠ auditor (pestaña Auditoría + agente `auditor-fiabilidad`). En el equipo: dev ≠ revisor ≠ auditor. |
| P6 confianza | Cada cifra en UI lleva badge. En el diario y los informes: `calculado` (derivado del diario) · `✓ comprobado automáticamente` (invariantes PASS) · `✓ validado contra fuente` (auditoría PASS o conciliación bancaria). En el **camino documental (E8)** cada CAMPO de la propuesta lleva uno de los **cuatro** niveles, sellados en `ExtractionRun.fieldOrigins` y pintados en `/unsorted/[fileId]`: **`calculado`** (lo derivó el motor: base, cuota, periodo de IVA) · **`verificado`** (lo puso una persona o el maestro: contraparte del maestro, fecha de recepción, ticket cualificado) · **`interpretacion_ia`** (lo leyó el modelo y nadie lo ha confirmado) · **`no_verificado`** (forzado con motivo, o campo que el motor no ha podido situar). Confirmar con algún campo `no_verificado` **exige motivo en el servidor** y queda en `AuditLog`. |
| P7 reproducible | `ExtractionRun` guarda modelo, proveedor, `prompt_sha` del prompt EFECTIVO, `schema_sha`, `proposal_sha`, páginas vistas/totales y tokens reales; es **append-only** (`REVOKE UPDATE, DELETE` + política RESTRICTIVE) y **I-E8-11 recomputa sus tres sellos** sobre el contenido de la fila, de modo que la inmutabilidad no depende sólo de los permisos. Editar una propuesta o forzar un campo NO modifica el run: crea uno de revisión colgado por `parentRunId` (ADR-0014 D5). `ReportRun` guarda git-sha de la app, `ledgerHash`, parámetros, duración, `validacion.json`. Prompts en `ai/prompts/*.md` versionados en git; la plantilla editable por usuario se guarda con `version` y `updatedAt`. |

## Invariantes de Capa 1 (siempre en código, `lib/ledger/invariants.ts`)

| ID | Invariante | Tolerancia |
|---|---|---|
| I1 | Por asiento: Σdebe = Σhaber | 0 |
| I2 | Balance: Σ saldos activo = Σ saldos pasivo + PN (incluyendo resultado del periodo) | 0 |
| I3 | **Definición única.** PyG del periodo = Σ(haber−debe) de líneas de grupos 6/7 cuyo asiento tiene `kind ∉ {REGULARIZATION, CLOSING, OPENING}`. Si el ejercicio está regularizado, además PyG = saldo acreedor de 129 tras la regularización | 0 |
| I4 | **Definición única.** Por cada nivel de margen, Σ de todas las columnas de la matriz analítica (proyectos + imputaciones a líneas de negocio sin proyecto + CECOs no imputados + amortización/deterioro + financiero/extraordinario + NO_ANALITICO) = PyG contable (I3) del mismo periodo. Ninguna línea 6/7 queda fuera de la matriz | 0 |
| I5 | Liquidación de CECO: Σ importes imputados (por run, fuente y nivel de margen) = saldo neto del CECO fuente en el periodo. Reparto por mayor resto (Hamilton): tolerancia **0**; los restos se asignan por mayor fracción y, en empate, al receptor de **menor código** (determinismo P7). Tras la liquidación completa, todo CECO imputable queda a 0 (E5) | 0 |
| I6 | Cashflow: saldo inicial 57x + Σ flujos del periodo = saldo final 57x | 0 |
| I7 | Sin duplicados: (`organizationId`, `code`) único en cuentas, proyectos, CECOs, LN; (`organizationId`, `entryNumber`) único en asientos | — |
| I8 | Fechas: asiento dentro de un ejercicio `OPEN`; sin fechas futuras respecto a `refDate` salvo previsión marcada | — |
| I9 | Toda línea referencia una cuenta activa del plan de la organización | — |
| I10 | Tenant: ninguna línea/asiento apunta a cuenta/proyecto/CECO de otra organización | — |

## Invariantes del camino documental (E8, `lib/ledger/invariants-e8.ts`)

Bloque aparte de I1–I10 y con el mismo contrato: **nunca un PASS que no se haya
comprobado**; lo que no se puede evaluar con los datos aportados sale `INFO`
diciendo qué falta. Tolerancia 0 en todos los que comparan cifras.

| ID | Invariante |
|---|---|
| I-E8-1 | Ningún asiento se apoya en un run que no lo sostiene: sin `reconcile`, en FAIL, `IMPORTED` o parcial de un modelo |
| I-E8-2 | Los bytes del documento son los que vio la extracción **y los de hoy**: `sha256(disco) = files.sha256 = runs.file_sha256`. Fichero ausente o alterado ⇒ FAIL con su ruta |
| I-E8-3 | `extraction_runs` y `prompt_versions` inmutables (RLS RESTRICTIVE; lo verifica `test:integration:rls` con un 42501) |
| I-E8-4 | Semántica de `Transaction.status` (`POSTED ⟺ journal_entry_id`) y un solo asiento vivo por operación; splits coherentes |
| I-E8-5 | `convertedTotal` se reproduce al céntimo con la tasa persistida, y esa tasa está en `exchange_rates` |
| I-E8-6 | Determinismo de `reconcile()`: `canonicalJson` idéntico entre ejecuciones y procesos |
| **I-E8-7a** | **Puente documento ↔ asiento**: la anotación del libro registro derivada del ASIENTO y la derivada de la PROPUESTA sellada —convertida con la tasa del run y con la diferencia de la rectificativa aplicada— coinciden céntimo a céntimo. Es quien detecta una propuesta manipulada o una conversión mal hecha |
| I-E8-7b | Métrica de calidad (no invariante): desviación entre la cuota del documento y la recalculada, por tipo y proveedor. Nunca FAIL: se contabiliza la del documento (ADR-0014 D3) |
| I-E8-8 | La previsualización reproduce el asiento línea a línea: es el MISMO código (`previewFromProposal`) |
| I-E8-9 | Sin `sha256` no se analiza ni se contabiliza |
| I-E8-10 | Un run parcial no tiene ni un campo `calculado` ni `verificado`, ni asiento si es de un modelo |
| I-E8-11 | Los sellos del run son los de su contenido: `proposal_sha`, `schema_sha` y `prompt_sha` recomputados |
| I-E8-12 | Aislamiento por tenant de runs, prompts, series y contrapartes |
| I-E8-13 | Un duplicado contabilizado exige `AuditLog FORCE_DUPLICATE` con motivo |
| I-E8-14 | `exchange_rates` append-only, única por `(fecha, par, fuente)` y con tasa positiva |
| **I-E8-15a/b/c** | Los **tres puentes al 303**: `Σ472 = Σ` cuota deducible del libro de recibidas · `Σ` cuota total = `Σ472 +` IVA no deducible incorporado al coste (art. 103 LIVA) · `Σ477 = Σ` repercutida de emitidas **+** devengada por ISP/AIB de recibidas (casillas 10-13). Van partidos en tres porque el invariante único fallaba con un ticket no cualificado, que es el caso por defecto |
| I-E8-16 | Nada se deduce pasados cuatro años (art. 99.Cinco LIVA) |
| I-E8-17 | Puente al 111 y al 115: lo practicado = lo abonado a 4751 |
| I-E8-18 | Una factura con ISP lleva exactamente dos líneas de IVA del mismo tipo y el devengado es íntegro (la prorrata sólo minora el deducible) |
| I-E8-19 | Divisa: las tres columnas en la transacción y en cada línea monetaria (NRV 11ª.2.1) |
| I-E8-20 | Series de facturación sin huecos y con fecha no decreciente (art. 6.1.a RD 1619/2012) |

El periodo de IVA de un documento es el trimestre de `max(receptionDate,
documentDate)` (ADR-0014 D8), **no** el del asiento.

Salida: `validacion.json` `{run_id, checks: [{id, status: PASS|FAIL, evidencia}]}` persistido en `ReportRun.validation`.

## Sello del entregable
- Todos PASS y auditoría (si aplica) CONFORME → `VALIDADO AUTOMÁTICAMENTE`.
- Cualquier FAIL / DISCREPANCIA / NO_VERIFICABLE / primer run tras cambio de motor / variación > umbral configurado (`Organization.reviewThresholds`) → `REQUIERE REVISIÓN` + motivo. La UI lo muestra en la pestaña Auditoría y en cabecera del informe.

### Motivos de sello que aporta el camino documental (E8, ADR-0014 D7)
Código cerrado; los aporta `reconcile()` documento a documento y se agregan al sello del periodo. Un motivo de sello es un dato de auditoría, no un texto libre.

| Motivo | Qué dice |
|---|---|
| `DOCUMENTO_ALTERADO` | Los bytes del fichero no son los que vio la extracción (I-E8-2) |
| `EXTRACCION_PARCIAL` | El modelo vio menos páginas de las que tiene el documento (G-02) |
| `CUOTA_DEL_DOCUMENTO_DISTINTA_DEL_RECALCULO` | Se contabiliza la del documento (D3) y la desviación se mide (I-E8-7b) |
| `DEDUCIBILIDAD_PENDIENTE` | Nadie ha decidido si la cuota es deducible (art. 96 LIVA) |
| `TASA_FORZADA` | El `convertedTotal` se forzó con motivo en vez de salir de la tasa |
| `REGIMEN_NO_SOPORTADO` | RECC/REDEME: el devengo sigue al cobro y la contabilización automática se bloquea (RC-24) |

## Invariantes de auditoría y conciliación bancaria (E7, `lib/audit/invariants-e7.ts`)

Bloque aparte de I1–I10 y de I-E8-*, con el mismo contrato: **nunca un PASS que
no se haya comprobado**; lo que no se puede evaluar con los datos aportados sale
`INFO` diciendo qué falta. **Tolerancia 0 en todo lo que compara importes**: en
conciliación no hay reparto por mayor resto, hay igualdad o no la hay.

**La identidad del cuadre.** A la fecha de corte `D`, **siempre por fecha de
operación**, y para UNA cuenta bancaria:

| | |
|---|---|
| `B` | saldo contable de la 57x: `Σ (debe − haber)` con `kind ∉ {CLOSING}` —**`OPENING` sí entra**—, con la MISMA función de la foto `PRE_REGULARIZACION` de E6 |
| `E` | saldo del extracto a `D`, **declarado por el banco** (nunca reconstruido) |
| `Ue` | Σ con signo de las líneas de extracto **no conciliadas** hasta `D`; los `IGNORED` entran y además se presentan como línea propia |
| `Ub` | Σ con signo de los apuntes de la 57x **no conciliados** hasta `D` |

> **I-E7-1 · `E − B = Ue − Ub`**, tolerancia 0.

Dos precisiones que la corrigen y sin las cuales el invariante miente:

- **Las cuatro cifras están en la MISMA moneda: la de la cuenta** (ADR-0015 D6.2).
  Si la cuenta no está en la moneda base, `B` y `Ub` salen de
  `journal_lines.original_amount_cents` / `original_currency` (`hashVersion = 3`),
  no del contravalor. La diferencia entre el contravalor histórico y `saldo en
  divisa × tasa de cierre` **no es un pendiente**: es la diferencia de cambio de
  la NRV 11ª.2.2 y la mide I-E7-12. Un apunte de una cuenta en divisa sin importe
  en esa divisa deja el cuadre **no evaluable**; nunca se mezclan monedas.
- **Un grupo de conciliación sólo cancela si TODOS sus miembros caen dentro del
  corte.** Es I-E7-11 (`Σ líneas = Σ apuntes`) lo que los cancela, y esa igualdad
  vale entera o no vale: el cheque contabilizado el 20-12 y cargado por el banco
  el 15-01 sigue siendo un pendiente a 31-12 —y tiene que serlo, o la identidad
  falla por su importe— aunque ya esté punteado.

| ID | Invariante | Tol. |
|---|---|---|
| **I-E7-1** | **Cuadre**: `E − B = Ue − Ub`, con los pendientes enumerados y tipados. Exige anclaje e I-E7-6b, o `INFO` | 0 |
| **I-E7-2** | Para toda conciliación viva: misma organización · cuenta de la `JournalLine` ∈ {572,573,574,575} e **igual** a la de la `BankAccount` · misma divisa · e **igualdad de importe con signo en la divisa de la cuenta**. En grupo, la igualdad es la de I-E7-11. La tolerancia de FECHAS no forma parte del invariante | 0 |
| **I-E7-3** | Ninguna línea de extracto ni ningún apunte 57x pertenece a dos grupos vivos (dos índices únicos parciales en la base) | — |
| ~~I-E7-4~~ | **Subsumido en I-E7-2**. Se conserva como evidencia legible del signo (cargo ⇔ haber de la 57x) | — |
| **I-E7-5** | Integridad de lo importado: `fileSha256` único por cuenta, `sha256` de línea único por cuenta, `lineNo` correlativo sin huecos | — |
| **I-E7-6a** | El extracto cuadra **consigo mismo**: `opening + Σ amountCents = closing` y `lineCount = declaredLineCount` (registro 33). `INFO` si el banco no declara saldos | 0 |
| **I-E7-6b** | **Cobertura de la cadena**: la unión de los periodos de extracto cubre `[anclaje, corte]` sin huecos ni solapes contradictorios. Un hueco es FAIL y deja I-E7-1 en `INFO`. El periodo de un extracto es el que **declara el banco** (registro 11 de la Norma 43, cabecera declarada del CSV), no el de su primer y su último movimiento | — |
| **I-E7-7** | **Reproducibilidad**: `checksHash` recomputado sobre `checks` = el almacenado, en los N últimos runs. Editar una fila por SQL lo delata nombrando el run | — |
| **I-E7-8** | **Cobertura del almacén**: todo `File` tiene veredicto en el último `StoreSweep` `DONE`, posterior al último fichero ingerido | — |
| **I-E7-9** | Todo `AllocationRun` `SEALED` tiene `linesHash`; los anteriores a la migración salen WARN enumerados, uno posterior sin él es FAIL | — |
| **I-E7-10** | **`allocation_lines` no alteradas** bajo un `ReportRun` vigente: `linesHash` recomputado = el sellado | 0 |
| **I-E7-11** | **Cuadre del grupo**: para todo grupo vivo, `Σ amountCents de sus líneas = Σ` importe con signo **en la divisa de la cuenta** de sus apuntes | 0 |
| **I-E7-12** | **Divisa** (NRV 11ª.2.2): el cuadre de una cuenta en moneda extranjera se hace **en su divisa**; la diferencia entre `saldo en divisa × tasa de cierre` y el contravalor histórico menos lo ya reconocido es la **diferencia de cambio** pendiente (768/668). A fecha de cierre sin asiento que la recoja, **WARN** con su importe. *Una diferencia de cambio jamás aparece en `Ue` ni en `Ub`* | 0 |
| **I-E7-13** | **Ignorados acotados**: motivo del vocabulario cerrado y, con `ERROR_BANCO_REVERSADO` o `YA_CONTABILIZADO_EN_OTRA_CUENTA`, la evidencia. `Σ` ignorado como línea propia; por encima del umbral de materialidad, WARN. Los `IMPORTE_CERO` se cuentan aparte y nunca disparan el WARN | — |
| **I-E7-14** | **Continuidad entre ejercicios** (art. 25 CCom): el saldo de apertura de N, cuenta a cuenta, = saldo de cierre de N−1. En alcance `FISCAL_YEAR` el borde carga además las líneas `OPENING` **posteriores al corte**, o el invariante no se podría evaluar justo donde importa | 0 |
| **I-E7-15** | **Saldos contrarios a su naturaleza**: `430` acreedor, `400`/`410` deudor, `473` acreedor, `572` acreedor sin póliza de crédito declarada. WARN nombrando cuenta e importe | — |
| **I-E7-16** | **Cuentas puente con saldo** (`555`, `551`, `4749`): FAIL a fecha de cierre de ejercicio, WARN intraperiodo | — |
| **I-E7-17** | **Sumas y saldos**: Σdebe = Σhaber del periodo **y mes a mes** (art. 28.1 CCom). I1 comprueba el asiento; éste comprueba el **libro** | 0 |

### Motivos de sello que aporta la auditoría (E7)

Código cerrado, como los de E8, y **entran en el sello igual que ellos**: un
AVISO que no mueve el sello es decorativo, y firmar «VALIDADO AUTOMÁTICAMENTE»
un periodo con la conciliación abierta es exactamente lo que el sello existe
para evitar. `seal` y `sealReasons` dicen siempre lo mismo.

| Motivo | Tipo | Qué dice |
|---|---|---|
| `CONCILIACION_PENDIENTE` | AVISO | Hay cuentas bancarias con movimientos sin conciliar en el periodo |
| `PARTIDA_EN_TRANSITO_ANTIGUA` | AVISO | Hay partidas en tránsito más antiguas que el `transitWarnDays` declarado de la cuenta |
| `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` | AVISO | Hay diferencias de cambio medidas y no reconocidas a fecha de cierre (768/668) |
| `ALMACEN_NO_BARRIDO` | ENTORNO | El almacén de ficheros no se ha barrido después del último documento ingerido |

### La regla del badge `✓ validado contra fuente` (P6, por COMPOSICIÓN)

> Una cifra lleva `✓ validado contra fuente` si y sólo si **todas** las cuentas
> que la componen están íntegramente conciliadas para el periodo, con I-E7-1 y
> **I-E7-6b** en PASS y **ni un pendiente sin explicar**.

Consecuencias que no se negocian:

- El epígrafe `B.VII.1 Tesorería` agrega TODAS las 57x, **caja incluida**, y la
  caja (570/571) no tiene extracto ni puede tenerlo: *una organización con caja
  no verá nunca el badge en la tesorería total del balance*. Lo verá en el
  detalle por cuenta bancaria. Un arqueo de caja firmado **no** es fuente
  equivalente (podría serlo en E12, con ADR).
- **Enumerar un pendiente no lo explica.** Un pendiente está **explicado** si y
  sólo si: (1) es del lado banco y lo recoge un asiento posterior ya conciliado;
  (2) es del lado libros y lo recoge una línea de extracto posterior ya
  conciliada —los dos, un grupo vivo **a caballo del corte**—; o (3) está
  **tipado** (vocabulario cerrado de seis tipos, declarado por una persona en
  `BankPendingKind`, nunca deducido de un texto) y su antigüedad es **menor** que
  el `transitWarnDays` de la cuenta. Cualquier otro **retira el badge**.
- **El badge se deriva en lectura y no se persiste jamás**: un extracto importado
  en febrero con un movimiento de diciembre tiene que poder retirar un badge ya
  concedido sobre diciembre.

## Invariantes de cierre, recurrentes y fiscalidad periódica (E9, `lib/closing/invariants-e9.ts`)

Mismo contrato que los anteriores: **nunca un PASS que no se haya comprobado**;
lo no evaluable sale `INFO` diciendo **qué falta**, y todo lo que compara importes
va con **tolerancia 0**. Son **27 ids** (I-E9-1a y 1b cuentan por separado, igual
que 10b), y los corre el barrido de auditoría cuando el alcance lleva ejercicio.

| Id | Qué garantiza | Tol. |
|---|---|---|
| **I-E9-1a** | `(regla, periodo)` único; toda ocurrencia `GENERADA` tiene asiento; ninguna `OMITIDA`/`FALLIDA` sin motivo | — |
| **I-E9-1b** | El `inputHash` de la ocurrencia recomputado coincide: dice qué ocurrencia nació con otra versión de la regla | — |
| **I-E9-2** | Lo posteado por cada regla de amortización = su cuadro | 0 |
| **I-E9-3** | El `scheduleHash` del cuadro del activo recomputado = el sellado | — |
| **I-E9-4** (O-28) | `Σ cuotas = coste + mejoras − residual vigente`; ninguna cuota negativa. Los activos **dados de baja o vendidos** quedan fuera, y el PASS dice **cuántos** | 0 |
| **I-E9-5** | Σ 68x atribuida = saldo de `28x` **por activo** y ≤ base amortizable. Sin `fixed_asset_id`, **INFO nombrando los activos**, jamás PASS por agregado (riesgo R14) | 0 |
| **I-E9-6** | Toda periodificación con periodo terminado está agotada y con saldo 0 | 0 |
| **I-E9-7** | Saldo de 480/485/567/568 = pendiente de devengo de las periodificaciones vivas | 0 |
| **I-E9-8a′** | Libro registro ↔ diario ↔ liquidación sellada (vive en `lib/closing/vat.ts`, con la regla que comprueba) | 0 |
| **I-E9-8b** | El `iva_period` persistido = `app.iva_period(...)` recomputado (clave canónica `AAAA-Qn`) | — |
| **I-E9-9** | La liquidación de IVA es reproducible **línea a línea** | 0 |
| **I-E9-10** (O-9/O-10) | Prorrata definitiva recomputada, múltiplo de 100 y derivada del libro; con documentos sin clave de operación, `INFO` y **nunca** un % | — |
| **I-E9-10b** (O-11) | Momento, importe y arrastre de la regularización de prorrata (634/639) | 0 |
| **I-E9-11** | Ningún asiento con línea de IVA en un periodo ya liquidado (B-6) | — |
| **I-E9-12** | Tras T-26, **todas** las cuentas de los grupos 6 y 7, **`6300` incluida**, a 0 | 0 |
| **I-E9-13** | `129` tras T-26 = I3 del ejercicio | 0 |
| **I-E9-14** (O-8) | Apertura = cierre **línea a línea**, con los saldos ya reclasificados | 0 |
| **I-E9-15** | Ningún asiento en un ejercicio `CLOSED` posterior a su `closedAt` | — |
| **I-E9-16** | Reclasificación largo↔corto: la suma por contraparte no cambia, toda posición reclasificada tiene vencimiento y **ninguna que venza dentro de la frontera queda en la cuenta de largo**. El universo son los **22 pares**, sembrados en el alta y con *fallback* en el motor: **nunca pasa por vacuidad** | 0 |
| **I-E9-17** (O-4/O-5) | Tras T-30, `D × r − S = 0` con la tasa **sellada** | 0 |
| **I-E9-18** | El asiento de diferencias de cambio no mueve ninguna posición **en divisa** | 0 |
| **I-E9-19** (O-1) | Valor actual: `descuento inicial = Σ intereses` y a vencimiento el pasivo vale su **nominal** | 0 |
| **I-E9-20** | El `ClosingRun` es reproducible y un ejercicio cerrado tiene exactamente uno `CERRADO` | — |
| **I-E9-21** | El acto de cerrar y de reabrir: un ejercicio `CLOSED` tiene su **regularización, su cierre y la apertura del siguiente posteados** (marcarlo sin ellos es FAIL); tras reabrir, los cuatro contra-asientos, los grupos 1 a 7 en su saldo previo y `129 = 0` —`6300` vuelve a 0 salvo que ya se haya recontabilizado el impuesto— | 0 |
| **I-E9-22** (O-16) | DUA: la base es la del DUA y el 477 depende del diferimiento | 0 |
| **I-E9-23** (O-18) | Distribución del resultado: reserva legal hasta el 20 % del capital, sin repartir por encima de lo distribuible | 0 |
| **I-E9-24** (O-4) | Ninguna cuenta **no monetaria** entra en el barrido de diferencias de cambio; las excluidas se **declaran** en la evidencia | — |
| **I-E9-25** (O-6) | Toda posición viva de `17x`/`52x` tiene desglose declarado, o motivo escrito; y el `scheduleHash` del cuadro de deuda recomputado = el sellado | — |
| **I-E9-26** | Barrido del 31/12: el devengo de RECC y lo pendiente quedan donde tienen que quedar (vive en `lib/closing/vat.ts`) | 0 |

### Familia `CIERRE` de la pestaña Auditoría

Los 27 ids entran en la familia **`CIERRE`** de `lib/audit/families.ts`, con la
misma regla que las otras siete: **una familia sin evaluar sale `SIN_EVALUAR`,
jamás en verde**. El bloque que los alimenta lo compone `readClosingInvariantInput`
en una sola transacción; si falta el dato, el check dice qué falta y no inventa.

### Motivos de sello que aporta el cierre (E9)

Código cerrado, como los de E7 y E8; los declara el catálogo de pasos
(`lib/closing/checklist.ts`) y viajan en `ClosingRun.sealReasons`. Un paso
**bloqueante** sin PASS no sella: impide cerrar.

| Motivo | Qué dice |
|---|---|
| `IVA_NO_LIQUIDADO` | Queda algún periodo de IVA del ejercicio sin liquidar |
| `IMPUESTO_DIFERIDO_NO_RECONOCIDO` | Diferencias temporarias, BIN o deducciones sin responder |
| `RESULTADO_SIN_DISTRIBUIR` | El resultado del ejercicio anterior sigue en `129` |
| `MODELO_200_PRESENTADO` | El impuesto se tocó con el modelo 200 ya presentado (art. 122 LGT: complementaria) |
| `CIERRE_REABIERTO` | El ejercicio se reabrió: el `ClosingRun` pasa a `REABIERTO` y a `REQUIERE REVISIÓN` |

### La reapertura (O-21, ADR-0016 D1)

Sólo se reabre un cierre **sellado**, y la reapertura se **registra** en él. Los
cuatro contra-asientos —T-28 → T-27 → T-26 → **T-25**— se fechan **dentro del
ejercicio que se reabre** y el espejo de un asiento de sistema **hereda su
`kind`**, de modo que el par netea en todos los filtros por `kind`. La base sólo
lo admite con el GUC `app.reopening_run_id` respaldado por un `ClosingRun` real
del tenant. Los pasos que hay que **recomputar antes de recerrar** quedan en
`PENDIENTE_RECOMPUTO`: los tres ajustes idempotentes **y el impuesto**, que O-21
revierte; sin él, `129` recogería el resultado **antes** de impuestos.

### Los puentes al 303, reformulados por el RECC (O-14)

Bajo RECC, `477` sólo recoge **lo cobrado** mientras el libro anota la factura
íntegra en su expedición (arts. 63 y 61 *decies* RIVA), así que los puentes de E8
daban **FAIL por diseño** en toda organización acogida. E9 los reformula con las
cuentas de pendiente incluidas:

- **I-E8-15a′** — `Σ 472 + Σ 4728 = Σ` cuota **deducible** del libro de recibidas
  del periodo, **más** el ajuste de prorrata del art. 105 (que se postea contra
  `472` con el `ivaPeriod` del último periodo del año, O-11).
- **I-E8-15c′** — `Σ 477 + Σ 4778 = Σ` cuota **repercutida** del libro de
  emitidas del periodo.

Un invariante que falla por hacer lo correcto es peor que no tenerlo: los
enunciados originales (`Σ 472` y `Σ 477` a secas) se conservan para el régimen
general, y `lib/closing/vat.ts` los sustituye por los primados cuando hay RECC
vigente.

## E10 · Presupuesto y horas — `I-E10-1…18` (familia `PRESUPUESTO`)

Los dieciocho viven en `lib/budget/invariants-e10.ts` (puros) y el bloque que los
alimenta lo compone `models/budget-invariants.readBudgetInvariantInput`, en la
misma transacción del barrido y **sólo con un ejercicio en el alcance**. Lección
cara de E9 y de E10: un invariante que nadie ejecuta no vigila nada —los
dieciocho fueron **código muerto** hasta la ronda 1—, y uno que falla con datos
limpios no distingue una manipulación.

| Id | Qué exige | Tolerancia |
|---|---|---|
| **I-E10-1** | `Σ` líneas por nivel = totales de la matriz, y los doce meses = el anual; ninguna celda queda fuera | 0 |
| **I-E10-2** | `desviación = real − presupuesto`, celda a celda; el % redondeado **no mueve el importe** | 0 |
| **I-E10-3** | `Σ driverBase` de las líneas `HOURS` = minutos aprobados y productivos de la ventana del **periodo**, ensanchada sólo si el `zeroBaseFallback` se aplicó | 0 |
| **I-E10-4** | Un `TimeEntry` APROBADO es inmutable: se corrige por **contra-apunte**, que casa con su original y nunca lo excede | 0 |
| **I-E10-5** | 0 ó 1 tarifa vigente por (empleado, fecha); sin tarifa el coste es **NO EVALUABLE**, jamás 0 ni la anterior | — |
| **I-E10-6** | `budgetHash` recomputado = el sellado, **con** las líneas de horas y **sin** `valid_to` (mutable al relevar) | 0 |
| **I-E10-7** | El forecast no solapa ni deja hueco: real hasta el corte, presupuesto después | 0 |
| **I-E10-8** | Celda única por (versión, mes, dimensión, cuenta) y **una sola** dimensión (O-A6) | 0 |
| **I-E10-9** | Una versión vigente por ejercicio y fecha; revisiones correlativas **por ejercicio** (BASE = 0, cada REVISADO la siguiente) | 0 |
| **I-E10-10** | Partes bien formados: minutos ≠ 0, `|min| ≤ 1 440` por fila **y agregado** por (empleado, día), fecha dentro del ejercicio y fuera de mes bloqueado | 0 |
| **I-E10-11** | Base `HEADCOUNT` = `Σ fteMilli` de los snapshots del periodo (**FTE·mes**); sin snapshot no es 0, es `PLANTILLA_AUSENTE` | 0 |
| **I-E10-12** | **Guarda**: el coste de las horas valoradas a tarifa no excede al personal contabilizado en `64x` **del ejercicio**. No es «lo repartido por un driver `HOURS`» —el driver dice cómo se reparte un saldo, no qué es— ni una comparación mes a mes: la nómina se devenga con su calendario y las horas con el suyo. La infraabsorción la **publica** el informe (O-E10-20), no la castiga el invariante | ≤ |
| **I-E10-13** | Reproducibilidad: dos ejecuciones con las mismas entradas dan el mismo JSON canónico; las **siete** tablas devuelven 0 filas y `42501` sin GUC | 0 |
| **I-E10-14** | Toda celda declara su `analyticType` y su signo lo fuerza el tipo (O-E10-6 + O-E10-23) | 0 |
| **I-E10-15** | Continuidad de vigencias: sin solape **y sin hueco** en el ejercicio (O-E10-8) | 0 |
| **I-E10-16** | Completitud: una versión cubre los doce meses o **declara** su `partialFrom` | 0 |
| **I-E10-17** | El `timeHash` sellado = el recomputado sobre la **ventana que el run persiste**, para **todo** run con driver de actividad; la ventana contiene el periodo y la consumida | 0 |
| **I-E10-18** | Comparabilidad: presupuesto y real en el mismo estado de imputación, o las celdas por dimensión ≥ MC3 **no se publican** | 0 |

### Familia `PRESUPUESTO` de la pestaña Auditoría

Los dieciocho entran en la familia **`PRESUPUESTO`** de `lib/audit/families.ts`,
con la misma regla que las otras ocho: **una familia sin evaluar sale
`SIN_EVALUAR`, jamás en verde**. Sin presupuesto ni partes el bloque se omite
entero —una organización que no presupuesta no ve dieciocho `INFO` inútiles—, y
con uno solo de los dos el otro dice **qué falta**.

### Motivos de sello que aporta el presupuesto (E10, ADR-0018 D5)

Código cerrado. Los compone `budgetSealReasons()` **a partir de los datos** y no
de los checks (lección H-4 de E7: el sello se calcula **después** de los motivos,
y `seal` y `sealReasons` dicen lo mismo).

| Motivo | Umbral | Qué dice |
|---|---|---|
| `DESVIACION_PRESUPUESTO` | **EV-11 / EV-13** | El `budgetHash` del periodo cambia respecto del run anterior, o dispara uno de los cuatro KPI de desviación (ingresos, EBITDA, MC3 y **la mayor por dimensión**, que es la que el total compañía compensa) |
| `PRESUPUESTO_AUSENTE` | **EV-12** | No hay versión vigente para el periodo: las columnas derivadas salen **vacías con leyenda**, nunca a cero |
| `HORAS_SIN_APROBAR` | **EV-15** | Hay minutos sin aprobar de receptores elegibles en la ventana del driver. Se emite **siempre**, también con base aprobada 0 (y entonces `shareOfBaseBps = null`): el 100 % sin firmar es el caso extremo del parcial, no una excepción |
| `PLANTILLA_AUSENTE` | **EV-16** | Un receptor de una regla `HEADCOUNT` no tiene ningún snapshot en el periodo: peso 0, que no es lo mismo que «no hay nadie» |
| `TARIFA_AUSENTE` | **EV-17** | Hay partes aprobados sin tarifa vigente ese día **y** el informe publica coste-hora o margen por hora |

`PRESUPUESTO_NO_SELLADO` **no existe**: EV-14 se retiró (O-E10-5) y un borrador
no produce un `ReportRun` —para eso está la previsualización—.

## Provenance por cifra
```json
{"valor": 1245032, "moneda": "EUR", "metrica": "mc3.proyecto.P-2026-004", "run_id": "…", "ledgerHash": "…",
 "calculado_por": "lib/analytics/margins.ts@<git-sha>", "registros_origen": "SELECT id FROM journal_lines WHERE …", "confianza": "calculado"}
```
Drill-down UI = ejecutar `registros_origen`.

**Una celda de desviación necesita TRES consultas** (§5.1 de E10), y cada una
tiene que devolver lo que la celda **acumula**: la matriz es cumulativa, así que
la de MC3 pide los niveles `≤ MC3`, todos los meses del periodo y —en el
presupuesto— la **composición** mes a mes (O-E10-9), no una versión suelta. Una
provenance que devuelve cero filas sobre una celda con importe es peor que
ninguna: afirma que no hay origen.

## Gobernanza
Nivel 2 (ADR + firma humana): `lib/ledger/**`, `lib/analytics/**`, `invariants.ts`, esquema de `JournalEntry/JournalLine/AllocationRule`, RLS, prompt del auditor, umbrales. Nivel 1: resto, con diff cero en cifras sobre fixtures.

## Registro de runs del equipo
`runs/registro.jsonl`, una línea por run: `{run_id, ts_utc, git_sha, tipo: "sprint|auditoria|informe", epica, agentes, modelos, tests: {pass, fail}, auditor, sello}`.
