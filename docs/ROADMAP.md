# ROADMAP — épicas y orden de ejecución

Estado: `PENDIENTE` · `DISEÑADA` (existe `docs/design/`) · `EN CURSO` · `CERRADA`. Cada épica se planifica con `/epica E<n>` y se ejecuta con `/sprint E<n>`. Nivel 2 = ADR firmado antes de codificar.

| Épica | Alcance | Depende de | Nivel | Estado |
|---|---|---|---|---|
| **E0 Base** | Sistema agéntico + docs, `lib/money.ts` + tests, hook de pureza, `runs/registro.jsonl`, CI (`.github/workflows/ci.yml`: lint, tsc, unit, integración, RLS como app_runtime, guard de pureza), `test:integration`/`test:integration:rls`/`test:all`. Pendiente menor: `test:e2e` Playwright, Supabase branch | — | 1 | CERRADA (salvo e2e/Supabase, se completan en E2) |
| **E1 Organizaciones y roles** | `Organization`, `Membership`, `Role`, `requireOrg`/`withOrg`, `tenantDb`+`tenantTransaction`, switcher, ajustes de organización, miembros, invitaciones, migración TaxHacker (user → org), ficheros por organización, RLS efectiva con `app_runtime` (escape hasta E3, ADR-0007), tenant leak + RLS tests | E0 | 2 (ADR-0002, 0007) | **CERRADA** 2026-09-04 (revisión APROBADA tras 3 rondas; deuda E3 en docs/ESTADO.md) |
| **E2 Plan de cuentas e impuestos** | `Account`, seed NPGC (GENERAL/PYMES), `OrganizationAccountMap`, `TaxRate`, UI árbol editable (crear/renombrar/desactivar), import CSV plan propio, `AuditLog` | E1 | 1 (config) | PENDIENTE |
| **E3 Libro diario** | `FiscalYear`, `PeriodLock`, `JournalEntry/Line`, `post/void`, numeración, constraints+trigger, plantillas de asientos tipo, asiento manual UI, mayor, sumas y saldos, invariantes I1, I7–I10, `ledgerHash`. **+ Retirar deuda RLS de E1** (escapes USING/WITH CHECK, FORCE sin escape, `tenantTransaction` en negocio) | E2 | 2 (ADR-0003) | PENDIENTE |
| **E4 Analítica base** | `BusinessLine`, `Project`, `CostCenter` (tipos default), `AnalyticType` por cuenta, destino analítico en líneas, `MarginLevelConfig`, PyG analítica sin imputaciones, I4 | E3 | 2 (ADR-0004) | PENDIENTE |
| **E5 Liquidación de CECOs** | `AllocationRule/Target/Run/Line`, drivers, cascada, Hamilton, UI de reglas y liquidación, reversión, I5, PyG analítica con MC3/EBITDA | E4 | 2 (ADR-0004) | PENDIENTE |
| **E6 Informes financieros** | Balance, PyG contable, cashflow directo/indirecto, `ReportRun` + provenance + sello, `report-table` con drill-down, export CSV/XLSX/PDF, dashboard sobre diario, I2, I3, I6 | E3 (E5 para analítica completa) | 2 (motor de informes) | PENDIENTE |
| **E7 Auditoría** | Pestaña Auditoría (checks, calidad de datos, AuditLog, runs, forzar revisión), `scripts/run-invariants.ts`, test de error inyectado, conciliación bancaria básica (`BankStatementLine`) | E6 | 1/2 | PENDIENTE |
| **E8 Documentos → asientos** | `ExtractionRun`, `PromptVersion`, `reconcile()`, propuesta de asiento desde OCR, confirmación, `Transaction.status`, `File.sha256`, eliminar `cachedParseResult`, `ExchangeRate` servidor, facturas emitidas → asiento, badges de confianza, cierre de gaps ALTA G-01…G-06 | E3, E2 | 2 (ADR-0005) | PENDIENTE |
| **E9 Cierre y recurrentes** | Regularización IVA, cierre/apertura de ejercicio, asientos recurrentes (amortización, periodificación), bloqueo de periodos | E3 | 1 | PENDIENTE |
| **E10 Presupuesto y horas** | `Budget`, presupuesto vs real, `TimeEntry`, `EmployeeRate`, driver HOURS | E5 | 1 | PENDIENTE |
| **E11 Plataforma SaaS** | Stripe por organización, backups por organización de todas las tablas, límites por plan, onboarding | E1 | 1 | PENDIENTE |
| **E12 Fiabilidad DoD** | README-FIABILIDAD.md, tests de aceptación C1–C7 end-to-end, test memoria borrada, propuesta v1.1 | E7, E8 | 1 | PENDIENTE |

## Orden sugerido de sprints
S1: E0 + E1 · S2: E2 + E3 · S3: E4 + E6 (balance/PyG) · S4: E5 + E6 (analítica, cashflow) · S5: E8 · S6: E7 + E9 · S7: E10 + E11 · S8: E12.

## Gaps ALTA de TaxHacker (docs/AUDITORIA-FIABILIDAD.md) → épica que los cierra
G-01 Σitems≠total sin validar y unidades mezcladas → E8 · G-02 extracción parcial sin marcar → E8 · G-03 `cachedParseResult` memoria de cifras → E8 · G-04 tasa de cambio en navegador sin persistir → E8 · G-05 `profitPerCurrency` NaN → E6 · G-06 series temporales a 0 sin aviso → E6.
