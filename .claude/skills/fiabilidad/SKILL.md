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

## Provenance por cifra
```json
{"valor": 1245032, "moneda": "EUR", "metrica": "mc3.proyecto.P-2026-004", "run_id": "…", "ledgerHash": "…",
 "calculado_por": "lib/analytics/margins.ts@<git-sha>", "registros_origen": "SELECT id FROM journal_lines WHERE …", "confianza": "calculado"}
```
Drill-down UI = ejecutar `registros_origen`.

## Gobernanza
Nivel 2 (ADR + firma humana): `lib/ledger/**`, `lib/analytics/**`, `invariants.ts`, esquema de `JournalEntry/JournalLine/AllocationRule`, RLS, prompt del auditor, umbrales. Nivel 1: resto, con diff cero en cifras sobre fixtures.

## Registro de runs del equipo
`runs/registro.jsonl`, una línea por run: `{run_id, ts_utc, git_sha, tipo: "sprint|auditoria|informe", epica, agentes, modelos, tests: {pass, fail}, auditor, sello}`.
