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
| P2 SoT única | `JournalEntry`/`JournalLine` es la ÚNICA fuente de cifras contables. `Transaction` (heredado de TaxHacker) pasa a ser "documento/operación" y nunca fuente de informes. Tasas de cambio en tabla `ExchangeRate` con fuente y fecha. |
| P3 snapshot | Un informe se genera para `(organizationId, periodo, ledgerHash)` donde `ledgerHash = sha256` ordenado de las líneas del periodo. El resultado se persiste en `ReportRun` con ese hash; si el diario cambia, el hash cambia y el informe anterior queda como histórico, nunca sobrescrito. |
| P4 memoria ≠ cifras | `File.cachedParseResult` se elimina. Los agentes de desarrollo no "recuerdan" saldos: los recalculan. |
| P5 segregación | Extractor (LLM) ≠ validador (`reconcile`) ≠ auditor (pestaña Auditoría + agente `auditor-fiabilidad`). En el equipo: dev ≠ revisor ≠ auditor. |
| P6 confianza | Cada cifra en UI lleva badge: `calculado` (derivado del diario) · `✓ comprobado automáticamente` (invariantes PASS) · `✓ validado contra fuente` (auditoría PASS o conciliación bancaria) · `interpretación IA` (propuesta OCR no confirmada) · `no verificado` (importado sin origen). |
| P7 reproducible | `ExtractionRun` guarda modelo, proveedor, hash del prompt, versión de schema, tokens. `ReportRun` guarda git-sha de la app, `ledgerHash`, parámetros, duración, `validacion.json`. Prompts en `ai/prompts/*.md` versionados en git; la plantilla editable por usuario se guarda con `version` y `updatedAt`. |

## Invariantes de Capa 1 (siempre en código, `lib/ledger/invariants.ts`)

| ID | Invariante | Tolerancia |
|---|---|---|
| I1 | Por asiento: Σdebe = Σhaber | 0 |
| I2 | Balance: Σ saldos activo = Σ saldos pasivo + PN (incluyendo resultado del periodo) | 0 |
| I3 | Resultado PyG (grupos 6/7) = saldo 129 tras regularización, o = Σ(7)−Σ(6) antes de ella | 0 |
| I4 | Σ PyG analítica (proyectos directos + CECOs + líneas de negocio no asignadas + no analítico) = PyG contable, por cada nivel de margen | 0 |
| I5 | Liquidación de CECO: Σ importes imputados = saldo del CECO en el periodo; remanente ≤ 1 céntimo asignado al mayor receptor | 1 céntimo |
| I6 | Cashflow: saldo inicial 57x + Σ flujos del periodo = saldo final 57x | 0 |
| I7 | Sin duplicados: (`organizationId`, `code`) único en cuentas, proyectos, CECOs, LN; (`organizationId`, `entryNumber`) único en asientos | — |
| I8 | Fechas: asiento dentro de un ejercicio `OPEN`; sin fechas futuras respecto a `refDate` salvo previsión marcada | — |
| I9 | Toda línea referencia una cuenta activa del plan de la organización | — |
| I10 | Tenant: ninguna línea/asiento apunta a cuenta/proyecto/CECO de otra organización | — |

Salida: `validacion.json` `{run_id, checks: [{id, status: PASS|FAIL, evidencia}]}` persistido en `ReportRun.validation`.

## Sello del entregable
- Todos PASS y auditoría (si aplica) CONFORME → `VALIDADO AUTOMÁTICAMENTE`.
- Cualquier FAIL / DISCREPANCIA / NO_VERIFICABLE / primer run tras cambio de motor / variación > umbral configurado (`OrganizationSettings.reviewThresholds`) → `REQUIERE REVISIÓN` + motivo. La UI lo muestra en la pestaña Auditoría y en cabecera del informe.

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
