# MODELO DE DATOS v1.0 (objetivo)

Convenciones: ids `uuid`; dinero `Int` céntimos (`BigInt` solo en agregados); fechas contables `@db.Date`; toda tabla de negocio con `organizationId` + uniques/índices compuestos; `createdAt/updatedAt`; nada de negocio se borra físicamente si tiene dependientes. **Nombres físicos en snake_case obligatorios**: `@@map("journal_lines")` y `@map("organization_id")` en toda tabla/campo nuevo (el SQL de RLS, triggers e informes usa snake_case). **Anulación = contra-asiento** (`reversesEntryId`); `voidedAt/voidedBy/voidReason` en `JournalEntry` son informativos y **ninguna query filtra por ellos** (el contra-asiento ya neutraliza el importe).

## Heredado de TaxHacker (se conserva, se añade `organizationId`)
`User`, `Session`, `Account` (auth; **conserva el nombre `Account` — la cuenta contable es `LedgerAccount`**), `Verification` (auth) · `Setting` (+ `version`, `updatedAt`) · `Category`, `Field`, `Currency`, `File` (+ `sha256`, − `cachedParseResult`), `Transaction` (+ `journalEntryId?`, `status: DRAFT|PROPOSED|POSTED|VOID`, `extractionRunId?`), `AppData`, `Progress`. `Project` heredado se sustituye por el `Project` analítico (migración: proyectos existentes → `Project` con LN `GENERAL`).

## Tenancy
```prisma
model Organization { id uuid; slug String @unique; name String; taxId String?; baseCurrency String "EUR"; timezone String "Europe/Madrid"; pgcVariant PgcVariant PYMES; ledgerEnabled Boolean true; analyticsRequired Boolean true; reviewThresholds Json?; plan String?; stripeCustomerId String?; createdAt }
model Membership { id; organizationId; userId; role Role; invitedBy?; acceptedAt?; @@unique([organizationId,userId]) }
enum Role { ADMIN EDITOR VIEWER }   enum PgcVariant { GENERAL PYMES }
```

## Plan de cuentas e impuestos
> Actualizado por **E2** (`docs/design/E2-plan-cuentas.md` ronda 2) tras la validación contable (`docs/design/E2-validacion-contable.md`). El modelo TypeScript se llama **`LedgerAccount`**, no `Account`: ese nombre lo ocupa better-auth y renombrarlo rompería el login (`prismaAdapter` resuelve los modelos por nombre). El nombre físico es `accounts`, que es lo que ven RLS, triggers e informes.

```prisma
model LedgerAccount { id; organizationId; code String @db.VarChar(12); name String; level Int; parentCode String?; nature Nature; statement Statement?; epigraph String?; epigraphPymes String?; bidirectional Boolean false; isContra Boolean false; analyticType AnalyticType?; cashflowBucket CashflowBucket?; isPostable Boolean true; isActive Boolean true; isSystem Boolean false; origin AccountOrigin MANUAL; createdAt; updatedAt
  @@unique([organizationId, code]) @@index([organizationId, parentCode]) @@index([organizationId, isActive, isPostable]) @@map("accounts") }
enum Nature { DEUDORA ACREEDORA }
enum Statement { BALANCE_ACTIVO BALANCE_PASIVO BALANCE_PN PYG ECPN }
enum AnalyticType { INGRESO_DIRECTO COSTE_DIRECTO_MC1 COSTE_DIRECTO_MC2 INDIRECTO_CECO AMORTIZACION_DETERIORO FINANCIERO EXTRAORDINARIO NO_ANALITICO }   // EXTRAORDINARIO sin uso en el seed: el PGC 2007 suprimió el resultado extraordinario
enum CashflowBucket { COBROS_CLIENTES PAGOS_PROVEEDORES PAGOS_PERSONAL PAGOS_IMPUESTOS OTROS_EXPLOTACION INVERSION FINANCIACION }   // E6, O-10
enum AccountOrigin { SEED MANUAL CSV_IMPORT }   // idempotencia del seed sin pisar ediciones del usuario
// `epigraph` = modelo normal · `epigraphPymes` = modelo abreviado/PYMES (numeración propia). Se guardan LAS DOS: cambiar de variante no obliga a reimportar. Selector único: epigraphFor(account, variant). La correspondencia NORMAL↔PYMES es una TABLA, no una regla: no se deriva por regex (E6 §1.3).
// `bidirectional` (7 cuentas: 551, 552, 5523–5525, 554, 555): saldo indistinto; statement/epigraph guardan la ruta DEUDORA y el balance reclasifica POR SIGNO al epígrafe espejo (R-B4, E6 §3.3), por cuenta postable y por su saldo neto a la fecha, nunca por línea y nunca compensando subcuentas (art. 37 CdC).
// `isContra` (165 cuentas: 28x, 29x, 39x, 49x, 59x, 406, 437, 606/608/609, 706/708/709): **NO interviene en el cálculo** (R-B3, E6). Con la regla de signo (activo +saldo / pasivo y PN −saldo) la contra-cuenta ya resta sola; restarla además la restaría dos veces. Es (a) presentación —marca `(−)`— y (b) check de signo (I-E6-10).
// `cashflowBucket`: bucket de la CONTRAPARTIDA de un movimiento de tesorería (columna `cashflow_bucket` del seed, 834 de 906 filas; `null` sólo en 57x, en los contenedores mixtos `4`/`5` y en los grupos 8/9). La categoría OPERATING/INVESTING/FINANCING **se deriva** con `cashflowCategoryOf(bucket)` y NO se almacena. Sustituye a la columna `cashflowCategory` de E2 (E6, O-9/O-10/O-12). Regla de validación **R-18′**: bucket obligatorio en toda cuenta postable salvo 57x.
model OrganizationAccountMap { id; organizationId; key AccountKey; accountCode String; @@unique([organizationId,key]) @@map("organization_account_maps") }
enum AccountKey {  // 57 claves. Las 43 primeras son de mapeo OBLIGATORIO (E3/E8); las 14 últimas se declaran ahora y las mapea su épica.
  CLIENTES PROVEEDORES ACREEDORES BANCO_DEFAULT CAJA IVA_SOPORTADO IVA_REPERCUTIDO IRPF_RETENIDO_CLIENTES IRPF_A_PAGAR
  HP_ACREEDORA_IVA HP_DEUDORA_IVA SS_ACREEDORA REMUNERACIONES_PENDIENTES RESULTADO_EJERCICIO VENTAS_DEFAULT COMPRAS_DEFAULT
  SUBCONTRATACION_DEFAULT ANTICIPOS_PROVEEDORES ANTICIPOS_CLIENTES DESCUENTO_PP_VENTAS DESCUENTO_PP_COMPRAS
  DEVOLUCION_VENTAS DEVOLUCION_COMPRAS RAPPEL_VENTAS RAPPEL_COMPRAS REDONDEO_GASTO REDONDEO_INGRESO
  IRPF_PROFESIONALES_A_PAGAR IRPF_ALQUILERES_A_PAGAR IRPF_TRABAJO_A_PAGAR IVA_SOPORTADO_ISP IVA_REPERCUTIDO_ISP
  AJUSTE_IVA_NEGATIVO AJUSTE_IVA_POSITIVO IMPUESTO_BENEFICIOS_GASTO HP_ACREEDORA_IS HP_DEUDORA_IS
  ACTIVO_IMPUESTO_DIFERIDO PASIVO_IMPUESTO_DIFERIDO PERIODIFICACION_GASTO PERIODIFICACION_INGRESO
  DIFERENCIA_CAMBIO_NEGATIVA DIFERENCIA_CAMBIO_POSITIVA
  RETENCIONES_CAPITAL_SOPORTADAS SS_DEUDORA ANTICIPOS_REMUNERACIONES SUELDOS_DEFAULT SS_EMPRESA_DEFAULT
  CLIENTES_DUDOSO_COBRO DETERIORO_CLIENTES DOTACION_DETERIORO_CREDITOS REVERSION_DETERIORO_CREDITOS
  PERDIDA_CREDITOS_INCOBRABLES CUENTA_PUENTE_TESORERIA COMISIONES_BANCARIAS REMANENTE RESULTADOS_NEGATIVOS_ANTERIORES }
// Defaults del seed: CLIENTES 430 · PROVEEDORES 400 · ACREEDORES 410 · BANCO_DEFAULT 572 · CAJA 570 · IVA_SOPORTADO 472 · IVA_REPERCUTIDO 477 · IRPF_RETENIDO_CLIENTES 473 · IRPF_A_PAGAR 4751 · HP_ACREEDORA_IVA 4750 · HP_DEUDORA_IVA 4700 · SS_ACREEDORA 476 · REMUNERACIONES_PENDIENTES 465 · RESULTADO_EJERCICIO 129 · VENTAS_DEFAULT 705 · COMPRAS_DEFAULT 600 · SUBCONTRATACION_DEFAULT 607 · ANTICIPOS_PROVEEDORES 407 · ANTICIPOS_CLIENTES 438 · 706/606/708/608/709/609 · REDONDEO 669/769 · IRPF 47510/47511/47512 · AJUSTE_IVA 634/639 · IS 630/4752/4709 · impuesto diferido 4740/479 · periodificación 480/485 · diferencias de cambio 668/768.
// `importNpgc(opts.useSubaccounts = true)` (default) crea 5720/4300/4000/4100 y 47510/47511/47512, deja los padres no postables y mapea SIEMPRE a la hoja (I-plan-1).
// `opts.createSoftwareAccounts = false` (default): 4720/4730/4760/4770 solo bajo demanda o al activar ISP/intracomunitarias, y siempre como SUBCUENTAS de 472/473/476/477.
model TaxRate { id; organizationId; code String; name String; kind TaxKind; rateBps Int; appliesTo TaxAppliesTo BOTH; accountCode String; counterAccountCode String?; linkedTaxRateId String?; validFrom Date; validTo Date?; isActive Boolean true; isSystem Boolean false; @@unique([organizationId,code,validFrom]) @@map("tax_rates") }
enum TaxKind { IVA IRPF RECARGO EXENTO }
enum TaxAppliesTo { SALE PURCHASE BOTH }
// `rateBps` (puntos básicos), NO `ratePermille`: el recargo de labores del tabaco es 1,75 % = 175 bps y no es entero en tanto por mil.
// UNA fila por tipo impositivo: `accountCode` = lado venta (477 / 4751), `counterAccountCode` = lado compra (472 / 473). La dirección la fija el asiento tipo. Con inversión del sujeto pasivo se usan LAS DOS en el mismo asiento.
// `linkedTaxRateId`: un RECARGO apunta al IVA que acompaña (5,2↔21 · 1,4↔10 · 0,5↔4 · 1,75↔tabaco). Tributo distinto, versionable por separado.
// `validFrom` SIEMPRE explícita (2025-01-01 en los tipos de IVA sembrados): un asiento de 2024 no puede coger el tipo de 2026. No se siembra ningún tipo derogado; IGIC/IPSI se cargan por organización desde el editor.
// Restricciones SQL: CHECK rate_bps 0..10000 · CHECK kind='EXENTO' ⇒ rate_bps=0 · CHECK valid_to >= valid_from · EXCLUDE USING gist (organization_id, code, daterange(valid_from, valid_to, '[]')) contra solapes de vigencia.
```
Política fiscal por organización (la consume el motor en E3, reglas R-IVA-1…R-IVA-8): `Organization.prorrataBps Int?` (**renombrado desde `prorrataPermille` en E3, O-7**: puntos básicos, la misma escala que `TaxRate.rateBps`), `Organization.taxRoundingMode TaxRoundingMode` (`PER_TIPO` por defecto: una cuota por tipo impositivo) y `Organization.redondeoToleranciaCents Int` (default 1; por encima, el asiento se bloquea). `Organization.pgcVariant` es **inmutable** en cuanto existe un asiento posteado.

Seed `seeds/npgc.csv` (13 columnas: `codigo,nombre,nivel,padre,grupo,naturaleza,estado_financiero,epigrafe,tipo_analitico,bidireccional,is_contra,pymes,epigrafe_pymes`): 906 filas · **794** en PGC PYMES (`pymes = 1`; el criterio contable —reglas P-01…P-13— vive en `build_npgc.py`, no en TypeScript) · 165 contra-cuentas · 7 bidireccionales.

## Ejercicios y diario
> Actualizado por **E3** (`docs/design/E3-libro-diario.md` ronda 2) tras la validación contable (`docs/design/E3-asientos-tipo.md`, veredicto CONFORME CON OBSERVACIONES). Las observaciones O-1, O-2, O-4 y O-7 se incorporan aquí; O-3 (`templateVersion`) → E8, O-5 (extremos de OPENING/CLOSING) → E9, O-6 (divisa en la línea) → E8, O-8 (`isForecast`) → E10, O-9 (`INVOICE_IN`) → E8.

```prisma
model FiscalYear { id; organizationId; code String; startDate Date; endDate Date; status FyStatus OPEN; lastEntryNumber Int 0; closedAt?; closedById?; @@unique([organizationId,code]) @@map("fiscal_years") }
enum FyStatus { OPEN CLOSED }
model PeriodLock { id; organizationId; fiscalYearId; month Int; lockedAt; lockedById?; reason?; @@unique([organizationId,fiscalYearId,month]) @@map("period_locks") }
model JournalEntry { id; organizationId; fiscalYearId; entryNumber Int
  documentDate Date?; accrualDate Date?; entryDate Date   // TRES fechas, ver abajo
  description String; kind EntryKind;  // PyG excluye kind ∈ {REGULARIZATION, CLOSING, OPENING}
  taxRoundingMode TaxRoundingMode      // SELLADO en el asiento (R-IVA-4): la política de la organización es mutable
  sourceType SourceType; sourceId String?; transactionId?; fileId?; extractionRunId?; templateCode String?
  reversesEntryId?; voidedAt?; voidedById?; voidReason?; postedById; postedAt; entryHash String
  lines JournalLine[]
  @@unique([organizationId,fiscalYearId,entryNumber])
  @@unique([organizationId,id,entryDate,fiscalYearId,kind])   // destino de la FK de denormalización
  @@index([organizationId,entryDate]) @@map("journal_entries") }
enum EntryKind { NORMAL OPENING CLOSING REGULARIZATION REVERSAL RECURRING }
enum SourceType { MANUAL DOCUMENT INVOICE_OUT BANK_IMPORT CSV_IMPORT RECURRING SYSTEM }
model JournalLine { id; organizationId; entryId; lineNo Int; accountCode String; debitCents Int; creditCents Int; description String?
  projectId?; costCenterId?; businessLineId?; analyticType AnalyticType?   // los tres ids: nullable y SIN FK hasta E4
  taxRateId?; taxBaseCents Int?; counterpartyId?; dueDate Date?            // dueDate: UNA línea 43x/40x por vencimiento
  entryDate Date; fiscalYearId; entryKind EntryKind                        // denormalizado, impuesto por FK compuesta
  @@unique([entryId,lineNo])
  @@index([organizationId,entryDate]) @@index([organizationId,accountCode,entryDate])
  @@index([organizationId,projectId]) @@index([organizationId,costCenterId]) @@map("journal_lines") }
```
Política fiscal: `Organization.prorrataBps Int?` — **puntos básicos, no por mil** (O-7: `TaxRate.rateBps` ya está en bps y `applyBps(cuota, prorrataBps)` no puede mezclar escalas). La cuota **no deducible incrementa el precio de adquisición** de la línea de gasto/inmovilizado (art. 103 LIVA, NRV 2ª y 10ª); se aplica desde E3. La regularización anual de prorrata y la de bienes de inversión (arts. 105–110 LIVA) van contra 634/639 en E9.

**Las tres fechas.** `documentDate` = expedición del documento; **selecciona el `TaxRate` vigente** (un documento de 2025 contabilizado en 2026 lleva el tipo de 2025). `accrualDate` = devengo (NRV 14ª), default `documentDate`. `entryDate` = fecha contable, la **única** que manda en ejercicio, mes de bloqueo, informes y `ledgerHash`; la fija `resolveEntryDate`, no el usuario: si el mes del devengo está bloqueado → primer día del primer mes abierto ≥ devengo (con la coletilla obligatoria `[devengo YYYY-MM-DD]` en la descripción); si su ejercicio está `CLOSED` → no se postea ahí, se usa T-22 en el ejercicio abierto; futura respecto de `refDate` → error.

**Numeración (N-1…N-7).** `entryNumber` entero ≥ 1, correlativo por `(organizationId, fiscalYearId)`, sin huecos: `SELECT … FOR UPDATE` sobre `fiscal_years` → `+1` → `INSERT`, todo en la misma transacción. Nunca una secuencia de Postgres: deja huecos al hacer rollback. Un asiento que falla validación no consume número; un número no se reutiliza ni se reasigna. Con fecha retroactiva **no se renumera**: el diario se presenta ordenado por `(entryDate, entryNumber)` y la Auditoría lista los fuera de secuencia como Info. `OPENING` es el nº 1 del ejercicio y `CLOSING` el último.

**Bloqueo de periodos (B-1…B-5).** Bloqueo **secuencial** (no se bloquea el mes *n* con *n−1* abierto); desbloquear *n* arrastra *n+1…12*; solo ADMIN, con motivo, a `AuditLog`, y solo con el ejercicio `OPEN`. Cerrar el ejercicio exige los 12 meses bloqueados, regularización y cierre posteados e invariantes en PASS. **`FyStatus = CLOSED` no es reversible**: reabrir equivale a reformular cuentas ya rendidas (arts. 253, 272, 279 LSC).

**Anulación.** Solo contra-asiento (`reversesEntryId`), espejo exacto que copia e invierte columnas sin recalcular nada. Fecha: la del original si su mes sigue abierto; si no, primer día del primer mes abierto ≥ esa fecha. Un `REVERSAL` **no se anula con otro `REVERSAL`** y hay **como máximo uno** por asiento anulado. `voidedAt/voidedBy/voidReason` son informativos y **ninguna query filtra por ellos**.

**Ejercicio cerrado.** Documento cuyo devengo cae en un ejercicio `CLOSED`: asiento en el ejercicio abierto contra **113/121** si el error es material o hay cambio de criterio (NRV 22ª), o **678/778** si no es significativo (epígrafe 13, dentro del resultado de explotación). Las cuentas **679/779 no existen** en el PGC 2007 y no están en `seeds/npgc.csv`.

Constraints SQL: `CHECK(debit>=0 AND credit>=0 AND (debit=0)<>(credit=0))`; FK compuesta `(organization_id, account_code)`; FK compuesta de denormalización `(organization_id, entry_id, entry_date, fiscal_year_id, entry_kind)`; constraint trigger diferido con Σdebe=Σhaber, **≥ 2 líneas y ≥ 1 a cada lado**; trigger de periodo (ejercicio OPEN + mes no bloqueado); trigger de cuenta postable y activa; índice único parcial de anulación; trigger anti contra-contra-asiento; `EXCLUDE` de solape de ejercicios; RLS estricta con `FORCE`; sin DELETE y sin UPDATE salvo las tres columnas de anulación (GRANT de columna).

**Asientos tipo:** las 28 plantillas (T-01…T-28), su aritmética, sus 13 comprobaciones comunes (C-1…C-13) y los invariantes propios I-E3-1…7 están en `docs/design/E3-asientos-tipo.md`. Fixtures inmutables verificados: `tests/fixtures/ejercicio-{minimo,completo}.json`, generados por `docs/design/fixtures/build_ejercicio_completo.py` (84 asientos, 326 líneas, 28/28 plantillas).

## Analítica
> Actualizado por **E4** (`docs/design/E4-analitica.md` ronda 2) tras la validación contable (`docs/design/E4-validacion-analitica.md`, **CONFORME CON OBSERVACIONES**). Se incorporan O-A1 (FK compuestas), O-A2 (CHECK de exclusividad y de «sin dimensión fuera de 6/7»), O-A3 (`analyticsHash`), O-A4 (`GRANT UPDATE` acotado), O-A5 (**`@@map`/`@map` en todo el bloque, que faltaba en los 14 modelos**), O-A7 (`MarginLevelConfig` versionada) y O-A8 (`closedAt`, `origin`, `isSystem`). Reglas de destino R-A1…R-A12 e invariantes I-E4-1…12: en el documento de validación.
>
> **Bloque de liquidación actualizado por E5** (`docs/design/E5-liquidacion.md`, **ADR-0013 APROBADO**) tras la validación contable (`docs/design/E5-validacion-liquidacion.md`, **CONFORME CON OBSERVACIONES**; cifras selladas en `docs/design/fixtures/liquidacion-esperada.json`, 25 checks). Se incorporan las diez observaciones: O-E5-1 (`AllocationLine.marginLevel` — **el nivel viaja con el importe**, E5-D1), O-E5-2 (`sourceShareBps`, E5-D2), O-E5-3 (**bps, no milésimas**, en las dos tablas), O-E5-4 (`zeroBaseFallback` + `fallbackApplied`), O-E5-5 (`amountCents` para `MANUAL`), O-E5-6 (`fiscalYearId`, `periodKind`, `status`, `lineCount`, `totalAllocatedCents`, run único vigente por periodo), O-E5-7 (**`allocationRunSetHash`** en lugar de `allocationRunId`), O-E5-8 (CHECK, triggers, RLS append-only), O-E5-9 (columnas `BL:<código>` en la matriz, E5-D3) y O-E5-10 (`code` único, `name` NOT NULL, índice de orden). **O-A6 NO queda cerrada en E5** (corrección fechada 2026-09-06, ronda 1 de revisión de E5): `Budget` no existe todavía, así que no hay tabla sobre la que crear los índices. Su épica de cierre es **E10**, en la misma migración que cree `budgets`; anotada en `docs/ESTADO.md` §E5.

```prisma
model BusinessLine { id; organizationId @map("organization_id"); code; name; color; sortOrder @map("sort_order"); isActive @map("is_active"); archivedAt? @map("archived_at"); isSystem @map("is_system"); createdAt; updatedAt
  @@unique([organizationId,code]) @@unique([organizationId,id]) @@map("business_lines") }
// `Project` NO es una tabla nueva: es el heredado de TaxHacker (`projects`, ya bajo RLS
// desde E1), al que E4 añade columnas. Así sobreviven la FK `Transaction.projectCode` y
// toda la UI heredada (D-E4-1). `color` y `llm_prompt` se conservan: E8 los usa.
model Project { id; organizationId; code; name; color; llm_prompt?; businessLineId @map("business_line_id"); counterpartyId? @map("counterparty_id"); status ProjectStatus ACTIVE; startDate? @db.Date; endDate? @db.Date; closedAt? @db.Date; closedById?; budgetRevenueCents?; budgetCostCents?; sortOrder; isActive; archivedAt?; createdAt; updatedAt
  @@unique([organizationId,code]) @@unique([organizationId,id]) @@map("projects") }
enum ProjectStatus { PLANNED ACTIVE CLOSED }   @@map("project_status")
model CostCenter { id; organizationId; code; name; kind CostCenterKind; marginLevel MarginLevel @map("margin_level"); allocatable Boolean true; sortOrder; isActive; archivedAt?; origin AccountOrigin MANUAL; isSystem Boolean false; createdAt; updatedAt
  @@unique([organizationId,code]) @@unique([organizationId,id]) @@map("cost_centers") }
enum CostCenterKind { MARKETING_VENTAS OPERACIONES_INDIRECTAS G_A DESARROLLO_PRODUCTO FINANCIERO EXTRAORDINARIO OTROS SIN_ASIGNAR }   @@map("cost_center_kind")
enum MarginLevel { INGRESOS MC1 MC2 MC3 EBITDA EBIT BAI RESULTADO }   @@map("margin_level")  // CostCenter.marginLevel ∈ {MC3, EBITDA} (CHECK)
// O-A7: versionada Y hasheada. `validFrom/validTo` conservan el histórico (un ejercicio
// cerrado reimprime con SU configuración, elegida por la fecha del periodo del informe);
// el hash, dentro de `analyticsHash`, impide servir un informe cacheado con otra.
// MLC-2: MC3 y EBITDA van SIEMPRE con `analyticTypes = []` — `INDIRECTO_CECO` se rutea por
// `CostCenter.marginLevel` (R-A7); listarlo contaría el importe dos veces.
model MarginLevelConfig { id; organizationId; level MarginLevel; label; analyticTypes AnalyticType[] @map("analytic_types"); sortOrder @map("sort_order"); isVisible @map("is_visible"); validFrom Date @map("valid_from"); validTo? Date @map("valid_to"); updatedAt
  @@unique([organizationId,level,validFrom]) @@map("margin_level_configs") }
// ── Liquidación de CECOs (E5, ADR-0013). Las cuatro tablas con `organization_id`
// —`allocation_rule_targets` incluida: sin él no puede llevar RLS—, `@@map`
// snake_case y FK compuestas por tenant `(organization_id, <id>)`.
model AllocationRule { id; organizationId; code String @db.VarChar(24); name String; sourceCostCenterId @map("source_cost_center_id"); targetKind TargetKind @map("target_kind"); driver Driver; period AllocPeriod; priority Int; sourceShareBps Int 10000 @map("source_share_bps"); zeroBaseFallback ZeroBaseFallback SKIP_WARN @map("zero_base_fallback"); targetFilter Json? @map("target_filter"); validFrom Date @map("valid_from"); validTo Date? @map("valid_to"); isActive; createdById?; closedById?; targets AllocationRuleTarget[]
  @@unique([organizationId,code]) @@unique([organizationId,id]) @@index([organizationId,sourceCostCenterId,period,priority]) @@map("allocation_rules") }
model AllocationRuleTarget { id; organizationId; ruleId @map("rule_id"); projectId? @map("project_id"); businessLineId? @map("business_line_id"); costCenterId? @map("cost_center_id"); percentBps Int? @map("percent_bps"); amountCents Int? @map("amount_cents"); sortOrder @map("sort_order") @@map("allocation_rule_targets") }
enum TargetKind { PROJECTS BUSINESS_LINES COST_CENTERS MIXED }   @@map("target_kind")   // MIXED: contrato, desaconsejado y sin uso (con `sourceShareBps` toda mezcla son N reglas de un driver)
enum Driver { FIXED_PERCENT REVENUE_SHARE DIRECT_COST_SHARE HOURS HEADCOUNT EQUAL MANUAL }   @@map("allocation_driver")
enum AllocPeriod { MONTH QUARTER YEAR }   @@map("alloc_period")
enum ZeroBaseFallback { SKIP_WARN EQUAL YTD PRIOR_PERIOD }   @@map("zero_base_fallback")
enum AllocationRunStatus { DRAFT SEALED SUPERSEDED REVERSED }   @@map("allocation_run_status")   // `STALE` NO se almacena: se DERIVA de los tres sellos. `DRAFT` es contrato: E5 nunca lo persiste
model AllocationRun { id; organizationId; fiscalYearId @map("fiscal_year_id"); periodKind AllocPeriod @map("period_kind"); periodStart Date @map("period_start"); periodEnd Date @map("period_end"); status AllocationRunStatus SEALED; ledgerHash @map("ledger_hash"); analyticsHash @map("analytics_hash"); rulesHash @map("rules_hash"); linesHash? @map("lines_hash") /* sello de la SALIDA, E5 ronda 1 */; gitSha @map("git_sha"); lineCount Int 0 @map("line_count"); totalAllocatedCents BigInt 0 @map("total_allocated_cents"); warnings Json []; runById? @map("run_by_id"); runAt @map("run_at"); supersededById? @map("superseded_by_id"); reversedAt? @map("reversed_at"); reversedById? @map("reversed_by_id"); reversalReason? @map("reversal_reason"); lines AllocationLine[]
  @@unique([organizationId,id]) @@map("allocation_runs") }
model AllocationLine { id; organizationId; runId @map("run_id"); ruleId @map("rule_id"); sourceCostCenterId @map("source_cost_center_id"); targetProjectId? @map("target_project_id"); targetBusinessLineId? @map("target_business_line_id"); targetCostCenterId? @map("target_cost_center_id"); marginLevel MarginLevel @map("margin_level"); amountCents BigInt @map("amount_cents"); driverBase BigInt @map("driver_base"); driverBaseTotal BigInt @map("driver_base_total"); driverShareBps Int @map("driver_share_bps"); fallbackApplied ZeroBaseFallback? @map("fallback_applied"); eligibilityReason? @map("eligibility_reason") @@map("allocation_lines") }
model Budget { id; organizationId; year Int; month Int; projectId?; costCenterId?; accountCode?; amountCents Int; @@map("budgets") }
// O-A6 **ABIERTA · cierre en E10** (corregido 2026-09-06: la migración de E5 no la cerró
// porque la tabla `budgets` no existe todavía; la crea E10). El `@@unique` con TRES columnas
// nullables NO impide duplicados (NULL <> NULL): al crear `budgets` hay que sustituirlo por
// cuatro índices únicos PARCIALES por combinación (proyecto+cuenta, proyecto sin cuenta,
// CECO+cuenta, CECO sin cuenta) —o `NULLS NOT DISTINCT`, PG 15+— más el
// CHECK `(project_id IS NULL) <> (cost_center_id IS NULL)`.
model TimeEntry { id; organizationId; userId; projectId; date Date; minutes Int; note? @@map("time_entries") }
model EmployeeRate { id; organizationId; userId; hourlyCostCents Int; validFrom; validTo? @@map("employee_rates") }
model Counterparty { id; organizationId; kind CounterpartyKind; name; taxId?; accountCode?; defaultTaxRateId?; email?; @@unique([organizationId,taxId]) @@map("counterparties") }  // clientes/proveedores
// `Organization.nonAnalyticLevel MarginLevel EBITDA` (CHECK ∈ {EBITDA, EBIT, BAI}): R-A11 —
// `630`/`633`/`638` van SIEMPRE a RESULTADO (fijo); el resto de NO_ANALITICO (73x/74x/75x,
// que son resultado de explotación) cae en este nivel. Nunca por encima de MC3.
```

**Dimensiones en la línea (E4).** `JournalLine.projectId/costCenterId/businessLineId` pierden el `CHECK` `journal_lines_analytics_e4` de E3 y ganan **FK compuestas por tenant** `(organization_id, project_id) → projects(organization_id, id)` y equivalentes para CECO y LN (O-A1, I-E4-7). Tres CHECK nuevos (O-A2): `project_id IS NULL OR cost_center_id IS NULL` (exclusividad, I-E4-2), `business_line_id IS NULL OR project_id IS NOT NULL`, y `left(account_code,1) IN ('6','7') OR (las cuatro columnas analíticas IS NULL)` (R-A1, I-E4-5). `analytic_type` almacena el **tipo efectivo** ya resuelto al postear (R-A2, con los override implícitos R-A3 `INDIRECTO_CECO + projectId ⇒ COSTE_DIRECTO_MC2` y R-A4 `directo + costCenterId ⇒ INDIRECTO_CECO`): la matriz lee, no decide. `business_line_id` lo copia el motor del proyecto **en el alta** y un trigger lo verifica (R-A9); nunca se recalcula, así que mover un proyecto de línea de negocio no altera informes ya emitidos.

**Tres sellos (E4-D2, ADR-0010).** `ledgerHash` **financiero v2 EXCLUYE** las cuatro columnas analíticas — si las incluyera, reimputar un gasto invalidaría balance, PyG, cashflow y diario ya sellados, que no cambian en un céntimo (P3/P7). `entryHash` sí las incluye y **se recalcula** al reclasificar, con lo que I-E3-7 sigue en PASS. `analyticsHash` (nuevo) = dimensiones + `marginConfigHash` + **`allocationRunSetHash`** (E5/ADR-0013: el sha256 del **conjunto ordenado** de `AllocationRun` `SEALED` contenidos en el periodo del informe, `sha256("")` si está vacío — con `allocationRunId` en singular, un informe anual con reglas mensuales se apoya en 12 runs y la caché serviría el de 11), y es el único que caduca informes, y solo los analíticos. El `analyticsHash` que sella un **`AllocationRun`** es el de **dimensiones** (`allocationRunSetHash = ∅`): un run no puede sellarse con un hash que lo incluya a sí mismo. `JournalEntry.hashVersion Int @default(2)`; la migración de E4 recalcula el histórico (viable solo por la ausencia de datos en producción) y v2 no se vuelve a tocar. `ReportRun.analyticsHash String?`, obligatorio por CHECK para `PYG_ANALITICA`/`PRESUPUESTO_REAL`/`DASHBOARD`, con clave de reutilización `(organizationId, type, ledgerHash, analyticsHash)`.

**Reclasificación analítica (ADR-0010, PROPUESTO).** `journal_lines` deja de ser estrictamente append-only: `GRANT UPDATE ("project_id","cost_center_id","business_line_id","analytic_type") ON journal_lines TO app_runtime` — **y nada más** — más `GRANT UPDATE ("entry_hash") ON journal_entries`, con trigger `journal_lines_only_analytics_update` que lanza si cambia cualquier otra columna (el propietario esquiva los GRANT, el trigger no) y trigger de ventana que prohíbe el `UPDATE` con el ejercicio `CLOSED`. Mes bloqueado: solo ADMIN con motivo. `AuditLog(entity="JournalLine", action="RECLASSIFY_ANALYTICS")` con `before`/`after` de las cuatro columnas y de ambos hashes, en la misma transacción.

**Semilla por organización.** Ocho CECOs (`CC-OPS` MC3 · `CC-DEV` MC3 · `CC-MKT` EBITDA · `CC-GA` EBITDA · `CC-FIN` no imputable · `CC-EXT` no imputable · `CC-OTR` · `CC-NA` `SIN_ASIGNAR`, de sistema y no imputable) y las ocho filas de `MarginLevelConfig`. Con `analyticsRequired = false`, una línea 6/7 sin destino se rutea a `CC-NA` y la Auditoría la marca WARN (R-A8); nunca queda a NULL.

## Extracción, FX, informes, auditoría
> `ReportRun` y `ManualReviewFlag` actualizados por **E6** (`docs/design/E6-informes.md` ronda 2) tras la validación contable (`docs/design/E6-validacion-estados.md`, **CONFORME CON OBSERVACIONES**; cifras selladas en `docs/design/fixtures/estados-esperados.json`, 47 checks). Se incorporan O-5 (`paramsHash` en la clave de reutilización), O-6 (`comparativeRunId`/`comparativeBasis`), O-7 (`sealReasons` con código), O-8 (`params.currency`), O-9/O-10/O-12 (`cashflowBucket` en `LedgerAccount`, categoría derivada, R-18′) y O-11 (el bloque del cashflow indirecto es función pura, **no** columna). O-13 (`AccountKey.PROVEEDORES_INMOVILIZADO → 523`) y O-4 quedan para **E8**; O-14 (`epigraphSortKey`) anotada y descartada por ahora.

> **E8 CERRADA** (`docs/design/E8-documentos-asientos.md`, ADR-0014 APROBADO). Lo que sigue es el esquema **final** del camino documental, no el objetivo: `ExtractionRun`, `PromptVersion`, `Counterparty` e `InvoiceSeries` existen en `prisma/schema.prisma` con RLS `FORCE`, y `Transaction` gana la máquina de estados de D1.

```prisma
// ── E8 · el camino documento → asiento ──────────────────────────────────────
model ExtractionRun {                                              // APPEND-ONLY
  id; organizationId; fileId; fileSha256 String                    // el sha de los bytes que vio el modelo
  kind ExtractionKind                                              // LLM | MANUAL | IMPORTED
  parentRunId?                                                     // D5: editar/forzar NO muta el run, cuelga una REVISIÓN
  provider String; model String; temperatureBps Int; attempts Json  // G-09: la cadena de fallback, con códigos y ms; sin cuerpos
  promptCode String; promptSource PromptSource; promptVersionId?; promptSha String   // sha del prompt EFECTIVO (I-E8-11)
  schemaVersion String; schemaSha String                           // G-17: una salida sólo vale contra el schema con el que se pidió
  pagesSent Int; pagesTotal Int; partial Boolean                   // G-02: `partial` lo escribe un trigger BEFORE INSERT
  rawOutput Json; proposal Json?; proposalSha? ; fieldOrigins Json? // los CUATRO badges de confianza, campo a campo
  reconcile Json?; reconcileStatus ReconcileStatus?                // veredicto sellado: 25 checks, sellos, conversión, delta
  tokensIn?; tokensOut?; costMicros?; durationMs Int; gitSha String
  createdById?; createdAt
  @@unique([organizationId,id]) @@index([organizationId,fileId,createdAt(desc)]) @@map("extraction_runs") }
// Inmutable de verdad: `REVOKE UPDATE, DELETE` + política RESTRICTIVE `USING(false)`, y **I-E8-11 recomputa
// `proposal_sha`/`schema_sha`/`prompt_sha`** sobre el contenido de la fila (el permiso no es evidencia). Cota de 256 KB.
enum ExtractionKind { LLM MANUAL IMPORTED }   enum ReconcileStatus { PASS WARN FAIL }   enum PromptSource { GIT ORG }

model PromptVersion { id; organizationId?; code String; version Int; content String; sha256 String; notes?; createdById?; createdAt; @@unique([organizationId,code,version]) }   // append-only: «editar» es insertar version+1
model Counterparty { id; organizationId; code; name; taxId?; countryCode?; vatNumber?; viesValid?; viesCheckedAt?
  withholdingRegime WithholdingRegime; withholdingRateCode?; surchargeRegime Boolean; isEmployee Boolean; isActive; notes?; createdAt; updatedAt
  @@unique([organizationId,code]) @@map("counterparties") }
// O-11/D11: **la calificación fiscal sale de la FICHA, no del papel**. La retención que se practica es la del
// régimen del maestro (RC-19); lo que el documento diga sólo contrasta.
model ExchangeRate { id; date Date; from String; to String; rateMicro BigInt; source String; fetchedAt; @@unique([date,from,to,source]) @@map("exchange_rates") }
// GLOBAL por diseño (ADR-0014 D7) y append-only con ENABLE+FORCE: la referencia del BCE es pública. La tasa es la
// del `documentDate` y se persiste con su fecha REAL de publicación; sin tasa no se convierte (RC-14).
model ReportRun { id; organizationId; type ReportType; periodStart Date; periodEnd Date; fiscalYearId?
  params Json; paramsHash String @db.Char(64)                    // O-5: la FOTO y la VARIANTE son parámetros, no tipos
  ledgerHash String; analyticsHash?; marginConfigHash?; allocationRunSetHash? @map("allocation_run_set_hash"); analyticsKey String "∅"   // trigger; NULL<>NULL (O-A6). E5/O-E5-7: `allocationRunId` SUSTITUIDO por el hash del conjunto
  gitSha String; result Json; resultKind ResultKind FULL; provenance Json; validation Json
  seal Seal; sealReasons Json []                                  // O-7: [{code, kind, message, invariantId?, kpi?, deltaBps?}]
  comparativeRunId?; comparativeBasis ComparativeBasis?           // O-6: contra qué se midió la variación
  durationMs Int; createdById?; createdAt
  @@unique([organizationId,type,periodStart,periodEnd,paramsHash,ledgerHash,analyticsKey,gitSha])
  @@index([organizationId,type,periodStart,periodEnd,createdAt(desc)]) @@index([organizationId,type,ledgerHash]) @@map("report_runs") }
enum ReportType { DIARIO MAYOR SUMAS_SALDOS BALANCE PYG PYG_ANALITICA CASHFLOW PRESUPUESTO_REAL DASHBOARD CASHFLOW_DIRECTO CASHFLOW_INDIRECTO }
// **E7**: `CASHFLOW` UNIFICADO. El método (directo/indirecto) es un PARÁMETRO
// (`params.method`), no un tipo: con dos tipos, la clave única dejaba emitir dos
// informes del mismo periodo que se contradecían y el selector de revisión manual
// sólo acotaba a uno de los dos. `CASHFLOW_DIRECTO`/`CASHFLOW_INDIRECTO` se
// CONSERVAN en el enum para que los `ReportRun` históricos sigan siendo legibles;
// `scripts/migrate-cashflow-report-type.ts` los migra (operador, `--apply`, marca
// antes del backfill, `NO FORCE` → DML → `FORCE`).
enum Seal { VALIDADO_AUTOMATICAMENTE REQUIERE_REVISION }   enum ResultKind { FULL SUMMARY }   enum ComparativeBasis { SAME_PERIOD_PREVIOUS_YEAR PREVIOUS_FISCAL_YEAR_CLOSE PREVIOUS_PERIOD NONE }
// **Append-only en RLS** como `audit_logs` (RESTRICTIVE … USING(false) en UPDATE y DELETE + REVOKE): un informe emitido no se corrige, se emite otro.
// `params` OBLIGATORIOS por tipo: BALANCE {snapshot: PRE_REGULARIZACION|POST_REGULARIZACION|POST_CIERRE, variant, currency, comparative} · PYG {variant, currency, comparative} · CASHFLOW {method, granularity, view, currency} · DASHBOARD {refDate, agingBuckets, currency}. `gitSha` va DENTRO de la clave: si no, tras un cambio de motor se serviría la caché vieja y el motivo «primer run tras cambio» no se emitiría nunca.
// `resultKind = SUMMARY` en DIARIO/MAYOR/SUMAS_SALDOS (D-E6-4): el resultado guarda el resumen y la consulta, no cientos de miles de filas.
// ── E7 · auditoría y conciliación bancaria (`docs/design/E7-auditoria.md` §2, ADR-0015) ──
// Ocho tablas nuevas, todas con `organization_id`, `enforce_tenant_rls` y FK COMPUESTAS por tenant.
// El esbozo de una sola `BankStatementLine` con `matchedLineId` no representaba
// ni una remesa ni un extracto: se sustituye por el modelo de abajo.
model InvariantRun { id; organizationId; scopeKind AuditScopeKind; fiscalYearId?; periodStart Date?; periodEnd Date?
  trigger AuditTrigger; refDate Date
  ledgerHash; analyticsKey; planHash; accountMapHash; configHash          // los CINCO hashes del sello (O-20)
  gitSha; checksHash String @db.Char(64); checks Json; counts Json; coverage Json
  headline Json                                                           // O-19: ACTIVO, PN_MAS_PASIVO, RESULTADO, TESORERIA con su provenance
  seal Seal; sealReasons Json; storeSweepId?; durationMs Int; runById?; createdAt
  @@map("invariant_runs") }
// **APPEND-ONLY DURO**: `REVOKE UPDATE, DELETE` + dos políticas RESTRICTIVE. I-E7-7 recomputa `checksHash`.
// `headline` se DERIVA por SQL del mismo estado que sella el run (O-19, ADR-0003), con `kind ∉ {CLOSING}`
// en activo, PN+pasivo y tesorería: incluir el cierre dejaba activo y PN+pasivo en 0,00 € justo el 31-12.
model StoreSweep { id; organizationId; status SweepStatus; filesTotal; filesOk; filesMissing; filesAltered
  bytesRead BigInt; findings Json; findingsOverflow Int; startedAt; finishedAt?; runById?; @@map("store_sweeps") }
model BankAccount { id; organizationId; code; name; accountCode                    // la 57x contra la que se puntea (O-7)
  currency String @db.VarChar(3); iban?; bic?; csvMapping Json?
  reconciledFromDate Date?; reconciledOpeningBalanceCents BigInt?                  // **el anclaje** (O-1): sin él, I-E7-1 sale INFO
  matchToleranceDays Int 3; transitWarnDays Int 90; ignoredMaterialityCents BigInt?; isActive
  @@unique([organizationId,code]) @@map("bank_accounts") }
model BankStatement { id; organizationId; bankAccountId; format StatementFormat; fileSha256; fileName; fileId?
  currency; periodStart Date; periodEnd Date                                       // **declarados por el banco**: registro 11 de la N43 o cabecera del CSV, NO el primer y el último movimiento
  openingBalanceCents BigInt?; closingBalanceCents BigInt?; declaredLineCount Int?; lineCount Int; importedById?
  @@map("bank_statements") }
model BankStatementLine { id; organizationId; statementId; bankAccountId; lineNo Int
  operationDate Date; valueDate Date                                               // el corte SIEMPRE por `operationDate` (O-6)
  amountCents BigInt                                                               // CON SIGNO, en la divisa de la cuenta
  currency; originalCurrency?; originalAmountCents BigInt?; balanceCents BigInt?
  description; reference1?; reference2?; conceptCommon?; conceptOwn?; counterpartyName?
  sha256; status BankLineStatus; ignoreReason IgnoreReason?; ignoreEvidenceId?; ignoredById?; ignoredAt?
  @@map("bank_statement_lines") }
model BankMatchGroup { id; organizationId; bankAccountId; kind MatchGroupKind; note?
  unmatchedAt?; unmatchedById?; unmatchReason?; createdById?; createdAt; @@map("bank_match_groups") }
model BankReconciliation { id; organizationId; groupId; statementLineId; journalLineId                 // **una `JournalLine`**, no un asiento
  method MatchMethod; scoreBps Int; dateGapDays Int                                // O-10: el desfase se SELLA, no se juzga
  groupUnmatchedAt?                                                                // espejo del grupo, lo escribe el trigger: los índices únicos parciales de I-E7-3 no pueden mirar otra tabla
  lineAnchor Boolean; cashAnchor Boolean; matchedById?; matchedAt; @@map("bank_reconciliations") }
model BankPendingKind { id; organizationId; bankAccountId; statementLineId?; journalLineId?             // CHECK: exactamente uno
  kind PendingKind; note?; declaredById?; declaredAt; @@map("bank_pending_kinds") }
enum AuditScopeKind { ORGANIZATION FISCAL_YEAR PERIOD }   enum AuditTrigger { MANUAL SCHEDULED POST_CLOSE POST_IMPORT }
enum SweepStatus { RUNNING DONE FAILED CANCELLED }        enum StatementFormat { CSV N43 MANUAL }
enum BankLineStatus { UNMATCHED MATCHED IGNORED }         enum MatchGroupKind { SIMPLE N_A_1 UNO_A_N N_A_N }
enum MatchMethod { MANUAL SUGGESTION_ACCEPTED }           // no hay AUTO: E7 no puntea solo
enum IgnoreReason { ERROR_BANCO_REVERSADO NO_ES_NUESTRA_CUENTA YA_CONTABILIZADO_EN_OTRA_CUENTA IMPORTE_CERO }
enum PendingKind { CHEQUE_EMITIDO_NO_CARGADO REMESA_NO_ABONADA TRASPASO_ENTRE_CUENTAS_EN_CAMINO
  MOVIMIENTO_BANCO_SIN_ASIENTO APUNTE_SIN_MOVIMIENTO EFECTO_EN_GESTION_DE_COBRO }
// `BankPendingKind` es tabla y no una columna del apunte porque el tipado es de los DOS lados y
// `journal_lines` es append-only (`app_runtime` sólo tiene SELECT, INSERT): el tipo de un pendiente es un
// dato de CONCILIACIÓN, no del asiento, y no entra en `entry_hash`. Se BORRA cuando el pendiente deja de serlo.
// **`bigint` en el diario (ADR-0015 D1)**: `journal_lines.debit_cents`/`credit_cents`/`tax_base_cents`/
// `original_amount_cents` pasan de `integer` a `bigint` — el techo de `integer` eran 21 474 836,47 € y el
// producto se vende a empresas de 1 a 100 M€. El motor y la interfaz SIGUEN en `number`: la conversión vive
// en el borde (`centsFromDb`/`centsToDb` de `lib/money.ts`), con `Number.isSafeInteger` y **excepción** por
// encima de 2^53−1 en vez de perder precisión en silencio. Los `entry_hash` no se mueven (`::text` es
// idéntico para `integer` y `bigint`).
model AuditLog { id; organizationId; userId?; entity String; entityId String; action String; before Json?; after Json?; reason String?; ts; @@index([organizationId,ts]) @@index([organizationId,entity,entityId,ts]) @@map("audit_logs") }   // E2: append-only también en RLS (FOR UPDATE/DELETE USING(false)); se escribe en la MISMA transacción que la mutación
model ManualReviewFlag { id; organizationId; periodStart Date; periodEnd Date; scope ReportType?; reason; createdById; createdAt; clearedAt?; clearedById?; clearReason?; @@index([organizationId,periodStart,periodEnd]) @@map("manual_review_flags") }
// E6: ADMIN fuerza `REQUIERE REVISIÓN` sobre todos los informes que solapen el periodo (`scope` null = todos). Semi-append-only: sin DELETE, y `UPDATE` sólo de las tres columnas de limpieza (GRANT de columna + trigger, patrón ADR-0010). Único flag activo por (org, periodo, scope) con dos índices únicos PARCIALES (`WHERE cleared_at IS NULL`), porque NULL<>NULL.
// `Organization.reviewThresholds` (E1, sin uso hasta E6): {version:1, comparativeBasis, kpis:{ingresos, ebitda, resultado, tesoreria, deuda, dso, margenBruto → {pctBps, minAbsCents, minPointsBps}}}. Dispara revisión si |Δ%| > pctBps **Y** |Δ| > minAbsCents. Base por defecto SAME_PERIOD_PREVIOUS_YEAR. Variaciones explicables EV-1…EV-6 (no disparan) y EV-7…EV-10 (disparan siempre): E6 §2.4.
model InvoiceSeries { id; organizationId; code; kind InvoiceSeriesKind; prefix; nextNumber Int; year Int?; lastHash String?; isActive; createdAt; updatedAt; @@unique([organizationId,code,year]) @@map("invoice_series") }
enum InvoiceSeriesKind { ORDINARIA RECTIFICATIVA SIMPLIFICADA }   // `kind` INMUTABLE por trigger; numeración sin huecos (I-E8-20, art. 6.1.a RD 1619/2012)

// ── E8 · `Transaction` deja de ser una tabla de apuntes y pasa a ser la OPERACIÓN ──
// status TransactionStatus DRAFT|PROPOSED|POSTED|VOID  ·  journalEntryId?  ·  voidedEntryId?  ·  voidedEntryIds[]
// extractionRunId?  ·  splitParentTransactionId?  ·  currencyCode, total, convertedTotal?, exchangeRateMicro?, rateDate?, rateSource?
// convertedTotalOverrideReason? (CHECK: ≥ 10 caracteres si se fuerza)
// CHECK D1: (DRAFT sin asiento) ∨ (PROPOSED sin asiento) ∨ (POSTED **⟺** journal_entry_id) ∨ (VOID con voided_entry_id).
// Transiciones legales por trigger: DRAFT→PROPOSED→POSTED→VOID, el atajo DRAFT→POSTED y la vuelta VOID→PROPOSED
// (anular y rehacer). Al anular, el asiento se TRASLADA a `voided_entry_id` y se apila en `voided_entry_ids`
// (append-only): nada se pierde y `POSTED ⟺ asiento` sigue siendo cierto (I-E8-4).
// `journal_lines` gana la tripleta de divisa (`original_currency`, `original_amount_cents`, `exchange_rate_id`),
// INMUTABLE (sin GRANT UPDATE) y con CHECK de coherencia: es lo que la NRV 11ª.2.1 revalorizará al cierre en E9.
// `files.sha256` pasa a NOT NULL y `files.cached_parse_result` **se elimina** (P4/G-03).
```

## Integridad (resumen)
| Regla | Dónde |
|---|---|
| Σdebe = Σhaber por asiento | código + constraint trigger diferido |
| Cuenta postable, activa, de la misma org | código + FK compuesta `(organization_id, account_code) → accounts(organization_id, code)` (creada en E2) |
| Mapa de sistema resoluble (I-plan-1): toda `AccountKey` obligatoria → cuenta existente, activa y postable | `validateAccountMap` + revalidación al sembrar + check de Auditoría |
| `statement` de cuenta oficial de nivel ≤ 3: inmutable; `epigraph`: ADMIN + motivo + `AuditLog`, prohibido con líneas en ejercicio `CLOSED` | código (R-10a/R-10b) |
| Fecha en ejercicio OPEN y mes no bloqueado | código + trigger |
| Numeración sin huecos | `FOR UPDATE` sobre `fiscal_years` (N-1…N-4); orden por fecha (N-5) es presentación, no restricción |
| Asiento con ≥ 2 líneas y ≥ 1 a cada lado | constraint trigger diferido |
| Denormalización de `entryDate`/`fiscalYearId`/`entryKind` coherente con el asiento | FK compuesta contra `@@unique([organizationId,id,entryDate,fiscalYearId,kind])` |
| Un solo contra-asiento por asiento, y nunca de un `REVERSAL` | índice único parcial + trigger |
| Método de redondeo y fechas del documento reproducibles | `taxRoundingMode`, `documentDate`, `accrualDate` sellados en el asiento |
| 6/7 con destino analítico si `analyticsRequired` (C-9, R-A8); exclusividad proyecto/CECO; sin dimensión fuera de 6/7 ni en `NO_ANALITICO` | código (E4) **+ CHECK + FK compuestas `(organization_id, project_id\|cost_center_id\|business_line_id)`** |
| `business_line_id` de la línea = el del proyecto en el alta (R-A9, I-E4-3) | código + trigger `journal_lines_business_line_denorm` (verifica, nunca rellena: rompería `entry_hash`) |
| Σ matriz analítica = PyG contable (I4) por nivel y en `RESULTADO`, tolerancia 0 | `lib/analytics/margins.ts` + test byte a byte contra `docs/design/fixtures/pyg-analitica-esperada.json` |
| Σ imputado por `(run, CECO fuente, nivel)` = base liquidable, **tolerancia 0** (Hamilton, desempate por menor código); todo CECO imputable con regla queda a 0 (I5) | `lib/analytics/allocate.ts` + `checkI5` + test byte a byte contra `docs/design/fixtures/liquidacion-esperada.json` |
| El nivel de margen **viaja con el importe** (E5-D1): `Σ_c Δ[ℓ][c] = 0` en cada nivel | `AllocationLine.margin_level` + CHECK ∈ {MC3, EBITDA} + I-E5-6 |
| Sin ciclos en la cascada CECO → CECO; `(priority, code)` es orden topológico; ni fuente ni destino no imputable | validación en la app **+** constraint triggers `allocation_rules_dag` / `_topological` / `_allocatable` (I-E5-1, 5, 7, 8) |
| `allocation_runs` semi-append-only (sólo las 5 columnas de sustitución/reversión) y `allocation_lines` append-only puro; un solo run `SEALED` por periodo | `GRANT` de columna + políticas RESTRICTIVE + índice único parcial (I-E5-9, I-E5-11) |
| Una `AllocationRule` con líneas emitidas no se edita: se cierra con `validTo` y se crea otra | trigger `allocation_rules_immutable_when_used` + `EXCLUDE` de solape de vigencias |
| Línea posteada: solo mutan las cuatro columnas analíticas, con motivo y `AuditLog` | `GRANT` de columna + triggers `journal_lines_only_analytics_update` y `..._reclassify_window` (ADR-0010) |
| Nada se borra: asientos, líneas, cuentas con movimientos, runs | RLS `FOR DELETE USING(false)` + código |
| `Activo = Pasivo + PN` con el resultado leído de 129 **o** inyectado (I3), nunca las dos cosas (I2, R-B5) | `lib/ledger/reports/balance.ts` + I-E6-11 y I-E6-13 |
| `cashflowBucket` en toda cuenta postable salvo 57x (R-18′); todo asiento con línea 57x reparte por línea y cuadra con Δ57x (I6) | `validate_cashflow()` en el generador del seed + `lib/ledger/reports/cashflow.ts` + test de exhaustividad sobre las 906 cuentas |
| `report_runs` inmutable; un informe no se corrige, se emite otro | RLS append-only (`USING(false)` en UPDATE/DELETE) + `REVOKE` + I-E6-16 |
| Anulación solo por contra-asiento; sin flag que excluya líneas de informes | código + ausencia de columna `voided` en líneas |
| `extraction_runs` / `prompt_versions` / `exchange_rates` append-only, y sus sellos recomputables | `REVOKE UPDATE, DELETE` + RLS RESTRICTIVE `USING(false)` + **I-E8-11** (recomputa `proposal_sha`, `schema_sha`, `prompt_sha`) |
| `POSTED ⟺ journal_entry_id`; transiciones de estado legales; histórico de anulaciones append-only | CHECK `transactions_status_entry_d1` + trigger `app.transactions_status_transition()` + I-E8-4 |
| Los bytes del documento son los que vio la extracción **y los de hoy** | `files.sha256 NOT NULL` + `lib/files-integrity.sha256OfStoredFile` (streaming) + **I-E8-2** (fichero ausente o alterado ⇒ FAIL con su ruta) |
| La cuota que se contabiliza es la **del documento**, y la desviación se mide sin corregirla | `taxOverrides` (ADR-0014 D3) + I-E8-7b; **no** hay línea de 669/769 por residuo de IVA |
| El libro registro de IVA cuadra con el diario, y el documento cuadra con el asiento | **I-E8-15a/b/c** (los tres puentes al 303) + **I-E8-7a** (documento ↔ asiento, tolerancia 0) |
| Divisa: residuo de conversión CERO por construcción; tres columnas por línea monetaria | `lib/fx/convert.convertDocumentToBase` (Hamilton sobre las cuotas, ADR-0014 D2) + CHECK + I-E8-19 |
| Series de facturación sin huecos y con `kind` inmutable | trigger + **I-E8-20** |
| `invariant_runs` append-only duro; su `checksHash` recomputable | `REVOKE UPDATE, DELETE` + dos políticas RESTRICTIVE + **I-E7-7** |
| Extracto, líneas, grupos y pertenencias SEMI-append-only: sólo las columnas de punteo, ignorado y desconciliación | `GRANT` de columna (patrón ADR-0010) + política `no_delete` por tabla |
| Nada pertenece a dos grupos de conciliación VIVOS | dos índices únicos PARCIALES sobre las filas ancla (`WHERE group_unmatched_at IS NULL`) + **I-E7-3** |
| El grupo cuadra **en la divisa de la cuenta**, tolerancia 0; un grupo vivo tiene ≥ 1 pertenencia | `app.bank_reconciliations_guard()` (SIMPLE) + constraint triggers diferidos `bank_match_groups_balanced` y `bank_match_groups_not_empty` + **I-E7-2/I-E7-11** |
| El extracto está en la divisa de la cuenta y la línea en la del extracto | trigger `bank_statements_currency_guard` (rechaza el fichero entero) |
| El importe de una línea de extracto es inmutable: sólo cambia su estado | `app.bank_statement_lines_only_status()` + `GRANT` de columna |
| El `File` de un extracto no se borra nunca | FK `RESTRICT` + comprobación en `scripts/prune-runs.ts` |
| Importes del diario en `bigint`, sin pérdida silenciosa en el borde | `centsFromDb`/`centsToDb` con `Number.isSafeInteger` y excepción |
| Tenant | `tenantDb` + RLS |
