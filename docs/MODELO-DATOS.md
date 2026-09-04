# MODELO DE DATOS v1.0 (objetivo)

Convenciones: ids `uuid`; dinero `Int` céntimos (`BigInt` solo en agregados); fechas contables `@db.Date`; toda tabla de negocio con `organizationId` + uniques/índices compuestos; `createdAt/updatedAt`; nada de negocio se borra físicamente si tiene dependientes. **Nombres físicos en snake_case obligatorios**: `@@map("journal_lines")` y `@map("organization_id")` en toda tabla/campo nuevo (el SQL de RLS, triggers e informes usa snake_case). **Anulación = contra-asiento** (`reversesEntryId`); `voidedAt/voidedBy/voidReason` en `JournalEntry` son informativos y **ninguna query filtra por ellos** (el contra-asiento ya neutraliza el importe).

## Heredado de TaxHacker (se conserva, se añade `organizationId`)
`User`, `Session`, `Account`, `Verification` (auth) · `Setting` (+ `version`, `updatedAt`) · `Category`, `Field`, `Currency`, `File` (+ `sha256`, − `cachedParseResult`), `Transaction` (+ `journalEntryId?`, `status: DRAFT|PROPOSED|POSTED|VOID`, `extractionRunId?`), `AppData`, `Progress`. `Project` heredado se sustituye por el `Project` analítico (migración: proyectos existentes → `Project` con LN `GENERAL`).

## Tenancy
```prisma
model Organization { id uuid; slug String @unique; name String; taxId String?; baseCurrency String "EUR"; timezone String "Europe/Madrid"; pgcVariant PgcVariant PYMES; ledgerEnabled Boolean true; analyticsRequired Boolean true; reviewThresholds Json?; plan String?; stripeCustomerId String?; createdAt }
model Membership { id; organizationId; userId; role Role; invitedBy?; acceptedAt?; @@unique([organizationId,userId]) }
enum Role { ADMIN EDITOR VIEWER }   enum PgcVariant { GENERAL PYMES }
```

## Plan de cuentas e impuestos
```prisma
model Account { id; organizationId; code String; name String; level Int; parentCode String?; nature Nature; statement Statement?; epigraph String?; analyticType AnalyticType?; cashflowCategory CashflowCategory?; isPostable Boolean; isActive Boolean true; isSystem Boolean false; createdAt; updatedAt
  @@unique([organizationId, code]) @@index([organizationId, parentCode]) }
enum Nature { DEUDORA ACREEDORA }
enum Statement { BALANCE_ACTIVO BALANCE_PASIVO BALANCE_PN PYG ECPN }
enum AnalyticType { INGRESO_DIRECTO COSTE_DIRECTO_MC1 COSTE_DIRECTO_MC2 INDIRECTO_CECO AMORTIZACION_DETERIORO FINANCIERO EXTRAORDINARIO NO_ANALITICO }
enum CashflowCategory { OPERATING INVESTING FINANCING }
model OrganizationAccountMap { id; organizationId; key AccountKey; accountCode String; @@unique([organizationId,key]) }
enum AccountKey { CLIENTES PROVEEDORES ACREEDORES BANCO_DEFAULT CAJA IVA_SOPORTADO IVA_REPERCUTIDO IRPF_RETENIDO_CLIENTES IRPF_A_PAGAR HP_ACREEDORA_IVA HP_DEUDORA_IVA SS_ACREEDORA REMUNERACIONES_PENDIENTES RESULTADO_EJERCICIO VENTAS_DEFAULT COMPRAS_DEFAULT }
// Defaults del seed (existen en npgc.csv): CLIENTES 430 · PROVEEDORES 400 · ACREEDORES 410 · BANCO_DEFAULT 572 · CAJA 570 · IVA_SOPORTADO 472 · IVA_REPERCUTIDO 477 · IRPF_RETENIDO_CLIENTES 473 · IRPF_A_PAGAR 4751 · HP_ACREEDORA_IVA 4750 · HP_DEUDORA_IVA 4700 · SS_ACREEDORA 476 · REMUNERACIONES_PENDIENTES 465 · RESULTADO_EJERCICIO 129 · VENTAS_DEFAULT 705 · COMPRAS_DEFAULT 600. `importNPGC` crea opcionalmente subcuentas 4720/4770 (`isSystem`) si la organización lo pide.
model TaxRate { id; organizationId; code String; kind TaxKind; ratePermille Int; accountCode String; counterAccountCode String?; validFrom Date; validTo Date?; @@unique([organizationId,code,validFrom]) }
enum TaxKind { IVA IRPF RECARGO EXENTO }
```

## Ejercicios y diario
```prisma
model FiscalYear { id; organizationId; code String; startDate Date; endDate Date; status FyStatus OPEN; lastEntryNumber Int 0; closedAt?; @@unique([organizationId,code]) }
enum FyStatus { OPEN CLOSED }
model PeriodLock { id; organizationId; fiscalYearId; month Int; lockedAt; lockedBy; @@unique([organizationId,fiscalYearId,month]) }
model JournalEntry { id; organizationId; fiscalYearId; entryNumber Int; entryDate Date; description String; kind EntryKind;  // PyG excluye kind ∈ {REGULARIZATION, CLOSING, OPENING} sourceType SourceType; sourceId String?; transactionId?; fileId?; extractionRunId?; templateCode String?; reversesEntryId?; voidedAt?; voidedBy?; voidReason?; postedBy; postedAt; lines JournalLine[]
  @@unique([organizationId,fiscalYearId,entryNumber]) @@index([organizationId,entryDate]) }
enum EntryKind { NORMAL OPENING CLOSING REGULARIZATION REVERSAL RECURRING }
enum SourceType { MANUAL DOCUMENT INVOICE_OUT BANK_IMPORT CSV_IMPORT RECURRING SYSTEM }
model JournalLine { id; organizationId; entryId; lineNo Int; accountCode String; debitCents Int; creditCents Int; description String?; projectId?; costCenterId?; businessLineId?; analyticType AnalyticType?; taxRateId?; counterpartyId?; dueDate Date?; entryDate Date; fiscalYearId; entryKind EntryKind (denormalizado)
  @@index([organizationId,entryDate]) @@index([organizationId,accountCode,entryDate]) @@index([organizationId,projectId]) @@index([organizationId,costCenterId]) }
```
Constraints SQL: `CHECK(debit>=0 AND credit>=0 AND (debit=0)<>(credit=0))`; FK compuesta `(organization_id, account_code)`; constraint trigger diferido Σdebit=Σcredit por entry; RLS; sin DELETE.

## Analítica
```prisma
model BusinessLine { id; organizationId; code; name; color; sortOrder; isActive; @@unique([organizationId,code]) }
model Project { id; organizationId; code; name; businessLineId; counterpartyId?; status ProjectStatus; startDate; endDate?; budgetRevenueCents?; budgetCostCents?; color; llmPrompt?; isActive; @@unique([organizationId,code]) }
enum ProjectStatus { PLANNED ACTIVE CLOSED }
model CostCenter { id; organizationId; code; name; kind CostCenterKind; marginLevel MarginLevel; allocatable Boolean true; isActive; @@unique([organizationId,code]) }
enum CostCenterKind { MARKETING_VENTAS OPERACIONES_INDIRECTAS G_A DESARROLLO_PRODUCTO FINANCIERO EXTRAORDINARIO OTROS SIN_ASIGNAR }
enum MarginLevel { INGRESOS MC1 MC2 MC3 EBITDA EBIT BAI RESULTADO }   // CostCenter.marginLevel ∈ {MC3, EBITDA} (validado)
model MarginLevelConfig { id; organizationId; level MarginLevel; label String; analyticTypes AnalyticType[]; sortOrder; @@unique([organizationId,level]) }
model AllocationRule { id; organizationId; code; name; sourceCostCenterId; targetKind TargetKind; driver Driver; period AllocPeriod; priority Int; targetFilter Json?; validFrom Date; validTo Date?; isActive; targets AllocationRuleTarget[] }
model AllocationRuleTarget { id; ruleId; projectId?; businessLineId?; costCenterId?; percentPermille Int? }
enum TargetKind { PROJECTS BUSINESS_LINES COST_CENTERS MIXED }  enum Driver { FIXED_PERCENT REVENUE_SHARE DIRECT_COST_SHARE HOURS HEADCOUNT EQUAL MANUAL }  enum AllocPeriod { MONTH QUARTER YEAR }
model AllocationRun { id; organizationId; periodStart Date; periodEnd Date; ledgerHash String; rulesHash String; gitSha String; runBy; runAt; supersededById?; reversedAt?; lines AllocationLine[] }
model AllocationLine { id; runId; ruleId; sourceCostCenterId; targetProjectId?; targetBusinessLineId?; targetCostCenterId?; amountCents Int; driverBase Int; driverSharePermille Int }
model Budget { id; organizationId; year Int; month Int; projectId?; costCenterId?; accountCode?; amountCents Int; @@unique([organizationId,year,month,projectId,costCenterId,accountCode]) }
model TimeEntry { id; organizationId; userId; projectId; date Date; minutes Int; note? }
model EmployeeRate { id; organizationId; userId; hourlyCostCents Int; validFrom; validTo? }
model Counterparty { id; organizationId; kind CounterpartyKind; name; taxId?; accountCode?; defaultTaxRateId?; email?; @@unique([organizationId,taxId]) }  // clientes/proveedores
```

## Extracción, FX, informes, auditoría
```prisma
model ExtractionRun { id; organizationId; fileId; provider String; model String; promptSha String; schemaVersion String; pagesSent Int; pagesTotal Int; partial Boolean; rawOutput Json; proposal Json?; reconcile Json?; tokensIn?; tokensOut?; durationMs; createdBy; createdAt }   // inmutable
model PromptVersion { id; organizationId?; code String; version Int; content String; sha256 String; createdBy; createdAt; @@unique([organizationId,code,version]) }
model ExchangeRate { id; date Date; from String; to String; rateMicro BigInt; source String; fetchedAt; @@unique([date,from,to,source]) }
model ReportRun { id; organizationId; type ReportType; periodStart; periodEnd; params Json; ledgerHash String; allocationRunId?; gitSha String; result Json; provenance Json; validation Json; seal Seal; sealReason?; durationMs; createdAt; @@index([organizationId,type,ledgerHash]) }
enum ReportType { DIARIO MAYOR SUMAS_SALDOS BALANCE PYG PYG_ANALITICA CASHFLOW_DIRECTO CASHFLOW_INDIRECTO PRESUPUESTO_REAL DASHBOARD }
enum Seal { VALIDADO_AUTOMATICAMENTE REQUIERE_REVISION }
model BankStatementLine { id; organizationId; accountCode; date Date; amountCents Int; description; reference?; sha256; matchedLineId?; importedAt }
model AuditLog { id; organizationId; userId?; entity String; entityId String; action String; before Json?; after Json?; reason?; ts; @@index([organizationId,ts]) }
model ManualReviewFlag { id; organizationId; periodStart; periodEnd; reason; createdBy; clearedAt?; clearedBy? }
model InvoiceSeries { id; organizationId; code; prefix; nextNumber Int; year Int?; lastHash String?; @@unique([organizationId,code,year]) }
```

## Integridad (resumen)
| Regla | Dónde |
|---|---|
| Σdebe = Σhaber por asiento | código + constraint trigger diferido |
| Cuenta postable, activa, de la misma org | código + FK compuesta |
| Fecha en ejercicio OPEN y mes no bloqueado | código + trigger |
| Numeración sin huecos | `FOR UPDATE` sobre `fiscal_years` |
| 6/7 con destino analítico si `analyticsRequired` | código |
| Nada se borra: asientos, líneas, cuentas con movimientos, runs | RLS `FOR DELETE USING(false)` + código |
| Anulación solo por contra-asiento; sin flag que excluya líneas de informes | código + ausencia de columna `voided` en líneas |
| Tenant | `tenantDb` + RLS |
