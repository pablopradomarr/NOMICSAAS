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
